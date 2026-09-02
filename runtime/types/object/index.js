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
const TYPE_DATE = 7; // Date:16B 块 [type@0, ts@8],ts 被当 count/props_ptr 即野扫
const TYPE_PROMISE = 11; // Promise:[type@0, status@8, value@16, ...],同隐患(print.js:607 实证)
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
// [I6] 函数值 name/length 删除墓碑位(仅用于闭包属性侧表条目;attr 常规位只用低 3 位,
// 0x80 不会由 defineProperty/freeze/seal 产生)。_closure_prop_del 删除 name/length 时
// 把侧表条目 value 置 undefined、attr 落 ATTR_FN_DELETED_TOMB(= 0x80|ATTR_CONFIGURABLE):
// _closure_prop_get 扫到 0x80 位即返 undefined **且不落元数据回落**(否则 _func_meta_name/
// _func_meta_arity 按 code_ptr 复活被删属性,delete 的"永久移除"语义失败)。保留
// CONFIGURABLE 位是必须:删后重赋时 _closure_prop_set 先以 _object_delete 清墓碑条目
// (其 _odel_hit 的 configurable 守卫见 0x80 无配置位会拒删 → 重赋永不生效),清后新值
// 按默认 attr=7(可写)落回(ES:configurable 属性删后可重建为普通数据属性)。
const ATTR_FN_DELETED = 0x80; // bit7: 函数 name/length 已删除墓碑(抑制元数据回落)
const ATTR_FN_DELETED_TOMB = 0x80 | ATTR_CONFIGURABLE; // 墓碑条目实际 attr(可配置 → 可被 _object_delete 清除)

// [W7b] 数组头 type 字 byte1 标志(与对象 EXT_* 同位布局,数组此前 byte1 恒 0)。
// length [[Writable]] 缺省 true;defineProperty(arr,"length",{writable:false}) 置本位置位。
const ARR_LEN_NONWRITABLE = 1; // bit0: array [[Length]] writable:false
const ARR_HAS_SIDETABLE = 2; // bit1: 已挂 _closure_props_registry。热路径 arr[i] 无此位则跳过 O(n) 链表。
const ARR_IS_ARGUMENTS = 32; // bit5: arguments 异质对象(越界写不抬 length)

// [#dp-mask] Object.defineProperty 字段存在位掩码(field-presence mask)。
// 编译器按描述符里**实际出现**的字段置位,运行时仅对出现的字段做验证/强制/改写;
// 未出现的字段保留既有值/属性位(绝不以 undefined 覆盖、绝不默认 false)。这是上一版
// 强制实现被回退的根因修复:旧版只看结果 attr 字节 + 可能 undefined 的 value,丢失了
// "哪些字段真被指定"的信息。掩码经打包参 (mask<<8)|attr 由 A5 传入 _object_define_property。
const DP_HAS_VALUE = 1;
const DP_HAS_WRITABLE = 2;
const DP_HAS_ENUMERABLE = 4;
const DP_HAS_CONFIGURABLE = 8;
const DP_HAS_GET = 16;
const DP_HAS_SET = 32;
// Internal packed-descriptor bit: Reflect.defineProperty requests a boolean
// result on ordinary validation failure, while Object.defineProperty throws.
// It is outside the six descriptor-field bits and never reaches attributes.
const DP_REFLECT_MODE = 64;

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
// 数组 byte1 bit0/bit1 与 ARR_LEN_NONWRITABLE / ARR_HAS_SIDETABLE 同位,不可用
// EXT_SEALED(bit1) 判别 isSealed(arr)。bit4 专作数组/arguments 的 seal 标记
// (freeze 仍用 EXT_FROZEN=bit2,与 ARR_* 无冲突)。
const EXT_ARRAY_SEALED = 16; // bit4: Array/Arguments 已 seal(非 freeze)
export class ObjectGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        this.generateObjectProtoEnsure(); // [W-B] 单例 Object.prototype 惰性物化(数据槽先登记)
        this.generateObjectNew();
        this.generateProxyNew();
        this.generateProxyRevocable();
        this.generateProxyTrapFn();
        this.generateProxyPrivHelpers();
        this.generateProxyIsPrototypeOf();
        this.generateThrowProxyInvariant();
        this.generateArefObjHelpers(); // [Stage A] Object.prototype 方法引用包装
        this.generateArefStaticTramp(); // [Stage A2] static non-constructor builtin trampoline
        this.generateProxyApplyTramp();
        this.generateProxyConstructCall();
        this.generateCompletePropDescriptor();
        this.generateObjectDefinePropertyProxy();
        this.generateFnConstructCall();
        this.generateObjectGet();
        this.generateObjectGetIC();
        this.generateThrowReadNullish();
        this.generateThrowTypeError();
        this.generateReFlagBrand();
        this.generateReFlagsGet();
        this.generateThrowReferenceError();
        this.generateObjectSetIC();
        this.generateObjectDelete();
        this.generateObjectForInKeys();
        this.generateMaybeGetter();
        this.generateAccessorDefine();
        this.generatePrivateBrandCheck();
        this.generateObjectSet();
        this.generateReflectSetReceiver();
        this.generateJsPropKey();
        this.generateObjectKeyEq();
        this.generateObjectHas();
        this.generateErrorOptHasCause();
        this.generateErrorMsgNorm();
        this.generatePropIn();
        this.generateObjectKeys();
        this.generateProxyOwnKeysValidate();
        this.generateObjectGetOwnPropertyNames();
        this.generateObjectGopnClassinfoOrder();
        this.generateObjectGetOwnPropertySymbols();
        this.generateObjectAllOwnKeys();
        this.generateObjectGetOwnPropertyDescriptors();
        this.generateIndexedIteratorProtos();
        this.generateFunctionKindTagProtos();
        this.generateObjectGetToStringTag();
        this.generateObjectProtoToString();
        this.generateObjectProtoToLocaleString();
        this.generateSetIteratorStub(); // Set[@@iterator] 桩 + Iterator 原型 tag 链
        this.generateObjectValues();
        this.generateObjectEntries();
        this.generateStringNew(); // Object.assign ToObject(string) / new String 同形包装
        this.generateObjectAssign();
        this.generateObjectAssignSet(); // assign 路径 Set(..., Throw=true)
        this.generateObjectRest();
        this.generateObjectCreate();
        this.generateHasOwnProperty();
        this.generateObjectToString();
        this.generateObjectValueOf();
        this.generateObjectCtorCall(); // [底层A W-A2] 裸 Object 值调用守卫(requires 'new')
        this.generateGetPrototypeOf();
        this.generateIsPrototypeOf();
        this.generateSetPrototypeOf();
        this.generateProtoAccessor(); // [__proto__] getter/setter on Object.prototype
        this.generateObjectSetIntegrityLevel();
        this.generateObjectFreeze();
        this.generateObjectSeal();
        this.generateObjectPreventExtensions();
        this.generateObjectTestIntegrity();
        this.generateObjectIsFrozen();
        this.generateObjectIsSealed();
        this.generateObjectIsExtensible();
        this.generateObjectIsValue();       // SameValue for Object.is() value path
        this.generateObjectFromEntries();   // runtime fallback for Object.fromEntries
        this.generateObjectDefinePropertiesDyn(); // runtime defineProperties via Object.keys
        // [#61 P2] per-property attributes
        this.generateObjectGrowFlags();
        this.generateObjectEnsureFlags();
        this.generateObjectGetAttr();
        this.generateObjectSetAttr();
        this.generateObjectSetPropAttr();
        // [#dp-mask] defineProperty 验证/强制(字段存在掩码)
        this.generateObjectDefinePropertyHelpers();
        this.generateObjectDefineProperty();
        this.generateObjectDefinePropertyDyn();
        this.generateArraySideElementHelpers(); // [W7b] 数组索引侧表 get/set(writable/accessor)
        this.generateArrayTrimSparseSide();
        this.generateCanonicalArrayIndex();
        this.generateObjectNormalizeOrder();
        this.generateObjectApplyClearAttrs();
        this.generateObjectGetOwnPropertyDescriptor();
        this.generateObjectPropertyIsEnumerable();
        this.generateGroupbyInvoke2();
        this.generateObjectGroupBy();
        this.generateClosurePropsHelpers();
        this.generateClosurePropGetRaw();
        this.generateShapeTransitions(); // [shape v2 · T0] 转移节点/转移表(惰性,无调用方)
        // [Annex B] Object.prototype.__defineGetter__/__defineSetter__/__lookupGetter__/__lookupSetter__
        // 独立新 label,放 generate() 末尾,避开与 getPrototypeOf 刀的中段冲突。
        this.generateAnnexBLegacyAccessors();
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
        // (当前全仓零调用点——过渡插入由 _shape_node_new 内部自探测处理;按 x64
        //  语义等价重写防未来重新接线踩雷:V0≡RET 恒 miss、V7≡A1 key 毁损已修。)
        vm.label("_shape_transition_get");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A1);           // key 先落 S0:x64 V7≡A1,下方 entries base 必毁
        vm.lea(VReg.V0, "_shape_transition_root");
        vm.load(VReg.V0, VReg.V0, 0);   // table
        // 先判表再置缺省:x64 V0≡RET≡RAX,旧序 load 表后 movImm(RET,0) 把表清零
        // 再自比恒真 → 恒返 0(恒 miss,函数体在 x64 不可达)。
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_stg_miss");            // 无表 → miss
        vm.load(VReg.V1, VReg.V0, 0);   // cap
        // h = (from>>4) ^ (key>>4);idx = h & (cap-1)
        vm.shrImm(VReg.V2, VReg.A0, 4);
        vm.shrImm(VReg.V3, VReg.S0, 4);
        vm.addImm(VReg.V7, VReg.V0, 16); // entries base
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
        vm.jeq("_stg_miss");            // 空槽 → miss
        vm.cmp(VReg.V3, VReg.A0);
        vm.jne("_stg_next");
        vm.load(VReg.V3, VReg.V5, 8);   // e.key
        vm.cmp(VReg.V3, VReg.S0);       // (S0=key;x64 A1 已被 V7 覆盖)
        vm.jne("_stg_next");
        vm.load(VReg.RET, VReg.V5, 16); // e.to — 命中
        vm.jmp("_stg_done");
        vm.label("_stg_next");
        vm.addImm(VReg.V5, VReg.V5, 24);
        vm.cmp(VReg.V5, VReg.V6);
        vm.jlt("_stg_loop");
        vm.mov(VReg.V5, VReg.V7);       // 绕回 base
        vm.jmp("_stg_loop");            // 装载因子 <0.7 → 必有空槽终止
        vm.label("_stg_miss");
        vm.movImm(VReg.RET, 0);
        vm.label("_stg_done");
        vm.epilogue([VReg.S0], 16);

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
    // _closure_prop_get_raw(A0=fn, A1=key) -> raw own side-table value.
    // Unlike _closure_prop_get, this helper never invokes TYPE_GETTER.  The
    // ordinary object Get path needs the marker so its caller can invoke the
    // accessor with the original receiver (important for inherited static
    // accessors such as MyRegExp[Symbol.species]).
    generateClosurePropGetRaw() {
        const vm = this.vm;
        vm.label("_closure_prop_get_raw");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // fn
        vm.mov(VReg.S1, VReg.A1); // key
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpgr_miss");
        vm.mov(VReg.S2, VReg.RET); // boxed props
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cpgr_miss");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get"); // raw value/TYPE_GETTER marker
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_cpgr_miss");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    generateClosurePropsHelpers() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        const OBJ_TAG = 0x7ffd000000000000n;

        vm.asm.addDataLabel("_closure_props_registry");
        vm.asm.addDataQword(0);

        // _cpr_make_table(A0=cap) -> 表头指针。布局:{tag@0, cap@8, count@16, buckets@24 inline}。
        // 供 _func_meta_init 建 code_ptr 哈希表;buckets 紧随表头,步长 8。
        vm.label("_cpr_make_table");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // cap
        vm.shlImm(VReg.V0, VReg.S0, 3); // cap*8
        vm.addImm(VReg.A0, VReg.V0, 24); // header+buckets
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.S1, 0, VReg.V0); // tag
        vm.store(VReg.S1, 8, VReg.S0); // cap
        vm.store(VReg.S1, 16, VReg.V0); // count
        // zero buckets
        vm.movImm(VReg.V1, 0); // i
        vm.label("_cpr_mt_zloop");
        vm.cmp(VReg.V1, VReg.S0);
        vm.jge("_cpr_mt_done");
        vm.shlImm(VReg.V2, VReg.V1, 3);
        vm.addImm(VReg.V3, VReg.S1, 24);
        vm.add(VReg.V3, VReg.V3, VReg.V2);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V3, 0, VReg.V0);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_cpr_mt_zloop");
        vm.label("_cpr_mt_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);

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
        vm.and(VReg.V2, VReg.S0, VReg.V1);
        vm.store(VReg.RET, 0, VReg.V2); // key = 裸 fn
        vm.store(VReg.RET, 8, VReg.S1); // props 裸
        vm.lea(VReg.V2, "_closure_props_registry");
        vm.load(VReg.V1, VReg.V2, 0);
        vm.store(VReg.RET, 16, VReg.V1); // next = 旧头
        vm.store(VReg.V2, 0, VReg.RET); // 头 = 新节点
        vm.movImm64(VReg.V1, OBJ_TAG);
        vm.or(VReg.RET, VReg.S1, VReg.V1); // 装箱 props
        vm.label("_cpe_done");
        // 数组键:置 ARR_HAS_SIDETABLE,让 _array_side_elem_* 热路径 O(1) 跳过链表。
        // 函数 magic 头不是 TYPE_ARRAY,不受影响。
        // x64 V0≡RET≡RAX:此处若用 V0 作 scratch 会毁掉刚装箱的 props,ensure
        // 实际返回裸 fn 指针 → _object_set 当对象写、侧表 count 恒 0
        // (f.foo=1 / assert.sameValue=fn 全失效)。先把 RET 挪到 S1。
        vm.mov(VReg.S1, VReg.RET); // boxed props
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V3, VReg.S0, VReg.V1);
        vm.load(VReg.V1, VReg.V3, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jne("_cpe_ret");
        vm.loadByte(VReg.V1, VReg.V3, 1);
        vm.orImm(VReg.V1, VReg.V1, ARR_HAS_SIDETABLE);
        vm.storeByte(VReg.V3, 1, VReg.V1);
        vm.label("_cpe_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _closure_prop_get(A0=fn, A1=key) -> value / undefined(无 props 或键 miss)。
        // 键 miss 且 key==="name"/"length" 时,查函数元数据侧表反射函数名/形参个数
        // (使运行期函数值——参数/成员链等——的 fn.name / fn.length 生效,不止编译期
        // 静态可知的访问点)。侧表**优先**:defineProperty 的覆盖值先命中。
        vm.label("_closure_prop_get");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A1); // 保存 key
        vm.mov(VReg.S1, VReg.A0); // 保存 fn(跨 _closure_props_find)
        vm.call("_closure_props_find"); // A0=fn → RET=props/undefined
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpg_miss");
        // [I6] 侧表命中判定改自扫描(不再委托 _object_get):需要命中槽的 attr 字节——
        // 墓碑位 ATTR_FN_DELETED(0x80,_closure_prop_del 落)标记 name/length 已删除,
        // 命中墓碑 → 直接返 undefined(**不落** _cpg_miss 元数据回落,否则被删属性经
        // _func_meta_* 复活,delete 永久移除语义失败)。普通命中(含删除后用户重建的
        // 条目,attr 默认 7)→ 返回槽值(即使 undefined);键 miss → _cpg_miss 元数据
        // 回落(W-22 语义不变:fn.x=1 之后 fn.name 仍经元数据反射)。侧表 props 是
        // _object_new 出的普通对象(__proto__=0),自扫描与 _object_get 语义等价。
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.S2, VReg.RET, VReg.V1); // S2 = raw props
        vm.load(VReg.S3, VReg.S2, 8);       // S3 = count
        vm.movImm(VReg.S4, 0);              // S4 = idx
        vm.label("_cpg_scan");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_cpg_miss");                // 侧表键 miss → 元数据回落
        vm.load(VReg.V2, VReg.S2, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);  // V0 = 槽地址
        vm.load(VReg.A0, VReg.V0, 0);       // 槽键
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_object_key_eq");          // 内容比较(驻留/堆串通用)
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cpg_hit");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_cpg_scan");
        vm.label("_cpg_hit");
        vm.load(VReg.V2, VReg.S2, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.S3, VReg.V0, 8);       // S3 = 槽值(count 已用完;x64 V3 跨 call 失效)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_get_attr");        // RET = attr 字节(flags_ptr=0 → ATTR_DEFAULT)
        vm.andImm(VReg.V0, VReg.RET, ATTR_FN_DELETED);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_cpg_undef");               // 墓碑 → undefined(抑制元数据回落)
        // [L1] 侧表 accessor → 调 getter。subscript 具名读(arguments.foo /
        // arr.prop)经本 helper 返值且**不**再套 _maybe_getter;此前原样返回
        // TYPE_GETTER 裸指针 → 读成 denormal float(4-315-1 等)。gOPD 走
        // props 上 _object_get(不经本 helper)仍得标记块。S1=接收者(this)。
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        // 键 miss:若 key==="name" 反射元数据名、key==="length" 反射元数据 arity(否则 undefined)。
        // [W-41] key==="prototype":惰性创建 F.prototype + constructor 回链(仅闭包 magic 0xc105)。
        vm.label("_cpg_miss");
        // [test262] caller/arguments 继承读(ES 18.2.1.1.3/1.4):侧表 miss 意味着
        // Function.prototype 上的 %ThrowTypeError% 访问器应派发——闭包侧表 proto=0
        // 无原型链,故按键显式拦截(S0=key)。仅函数接收者:数组/arguments 具名读也
        // 走本 helper,arguments.caller 在 sloppy 应是 undefined,不能套 %ThrowTypeError%。
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_cpg_forbid_keys");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_cpg_miss_notfn");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_cpg_miss_notfn");
        vm.load(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, 0xc105);
        vm.jeq("_cpg_forbid_keys");
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 3); // TYPE_FUNCTION
        vm.jne("_cpg_miss_notfn");
        vm.label("_cpg_forbid_keys");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);        // V0 = key payload
        vm.lea(VReg.V1, vm.asm.addString("caller"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cpg_forbidden");
        vm.lea(VReg.V1, vm.asm.addString("arguments"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cpg_forbidden");
        vm.label("_cpg_miss_notfn");
        // [W-27 守卫] 元数据反射要**解引用** fn 的载荷([P] 读 magic),故先验形态:
        // 只有装箱函数(高16=0x7FFF)与裸堆/代码指针(高16=0)可解引用。数字等非指针值
        // 的载荷是尾数位,当地址解会 SIGSEGV——静态解析成函数、运行期却被重新赋成数字的
        // 接收者(`var g=foo; g=42; g.name`)即此形态。此前只有 "name" 走该解引用,现在
        // "length" 也走,曝面变大,故在此统一挡掉(非指针形态 → undefined,不解引用)。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cpg_key_ck");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_cpg_undef");
        // [W-41] 普通闭包(magic 0xc105):若 key==="prototype" 惰性创建。
        // 先判键再判 aref:方法闭包的 name/length 仍走下方 _cpg_key_ck 元数据反射。
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);          // V0 = key payload
        vm.lea(VReg.V1, vm.asm.addString("prototype"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_cpg_key_ck");                       // 不是 "prototype" → name/length
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1);          // V0 = raw fn ptr
        vm.load(VReg.V2, VReg.V0, 0);               // V2 = magic
        vm.cmpImm(VReg.V2, 0xc105);
        vm.jne("_cpg_key_ck");                       // 非普通闭包 → 跳过 prototype
        // 方法值闭包 {0xc105, _aref_generic|_aref_static_tramp, helper}:无 [[Construct]]/无 .prototype。
        // 若仍惰性创建会让 String.prototype.charAt.prototype 变成对象(S15.*.A6 回归)。
        vm.load(VReg.V2, VReg.V0, 8);               // code_ptr
        vm.lea(VReg.V1, "_aref_generic");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_cpg_undef");                        // aref 蹦床 → 无 prototype
        vm.lea(VReg.V1, "_aref_static_tramp");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_cpg_undef");                        // 静态非构造器 → 无 prototype
        // Bound functions have no .prototype (ES 10.4.1.3). Lazy-create made
        // `class C extends fn.bind()` succeed without an assigned prototype.
        vm.lea(VReg.V1, "_bound_tramp");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_cpg_undef");
        // [TA ctor] 别名 TA 构造器闭包(var TA = Uint8Array)的 .prototype 读:经
        // _get_ctor_proto(type@16) 物化按型原型(与方法表齐全的 %TypedArray%.prototype
        // 链对齐),与编译器静态 Uint8Array.prototype 读同源——惰性空原型会让
        // TA.prototype.at/toReversed 等恒 undefined(TypedArray at/to* 族)。
        vm.lea(VReg.V1, "_ta_ctor_tramp");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jne("_cpg_lazy_proto");
        vm.load(VReg.A0, VReg.V0, 16);               // type@16
        vm.call("_get_ctor_proto");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_lazy_proto");
        // AsyncGeneratorFunction singleton: .prototype is %AsyncGeneratorFunction.prototype%
        // (already has .prototype = %AsyncGenerator.prototype%). Do not lazy-create
        // an empty object (that made constructor.prototype.prototype a raw pointer).
        vm.lea(VReg.V0, "_asyncgenfunc_singleton");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jne("_cpg_lazy_proto_mk");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cpg_lazy_proto_mk");
        vm.call("_ensure_asyncgenfunc");
        vm.lea(VReg.V0, "_nsobj_asyncgenfunc_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_lazy_proto_mk");
        // Async functions are non-constructors and have no own "prototype".
        // They share the ordinary compact closure layout, so metadata is the
        // authoritative discriminator before generic lazy creation.
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 0xc105); vm.jeq("_cpg_lazy_proto_meta_closure");
        vm.cmpImm(VReg.V2, 0xa51c); vm.jeq("_cpg_lazy_proto_meta_closure");
        vm.mov(VReg.A0, VReg.V0);
        vm.jmp("_cpg_lazy_proto_meta_find");
        vm.label("_cpg_lazy_proto_meta_closure");
        vm.load(VReg.A0, VReg.V0, 8);
        vm.label("_cpg_lazy_proto_meta_find");
        vm.call("_func_meta_find");
        vm.cmpImm(VReg.RET, 2); vm.jeq("_cpg_undef");
        // --- lazy F.prototype creation ---
        // 1. create prototype object (raw)
        vm.call("_object_new");                      // RET = raw prototype
        // 2. box raw prototype -> 0x7FFD
        vm.mov(VReg.V2, VReg.RET);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.V2, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.V2, VReg.V1);         // RET = boxed prototype
        vm.mov(VReg.S0, VReg.RET);                  // S0 = boxed proto (callee-saved, safe across calls)
        // Generator/AsyncGenerator F.prototype inherits from its matching
        // intrinsic generator prototype.
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 0xc105); vm.jeq("_cpg_lp_kind_clo");
        vm.cmpImm(VReg.V2, 0xa51c); vm.jeq("_cpg_lp_kind_clo");
        vm.mov(VReg.A0, VReg.V0);
        vm.jmp("_cpg_lp_kind_lk");
        vm.label("_cpg_lp_kind_clo");
        vm.load(VReg.A0, VReg.V0, 8);
        vm.label("_cpg_lp_kind_lk");
        vm.call("_func_meta_find");
        vm.cmpImm(VReg.RET, 1); vm.jeq("_cpg_lp_kind_gen");
        vm.cmpImm(VReg.RET, 3); vm.jeq("_cpg_lp_kind_asyncgen");
        vm.jmp("_cpg_lp_kind_skip");
        vm.label("_cpg_lp_kind_gen");
        vm.call("_ensure_gen_proto");
        vm.jmp("_cpg_lp_kind_link");
        vm.label("_cpg_lp_kind_asyncgen");
        vm.call("_ensure_asyncgen_proto");
        vm.label("_cpg_lp_kind_link");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.RET, VReg.V1);         // raw intrinsic generator proto
        vm.and(VReg.V0, VReg.S0, VReg.V1);          // raw F.prototype
        vm.store(VReg.V0, 16, VReg.A0);             // [[Prototype]]
        vm.label("_cpg_lp_kind_skip");
        // 3. prototype.constructor = fn
        // S0 still boxed proto; RET was kind / raw ptr after the hang (x64 V0≡RET).
        vm.mov(VReg.A0, VReg.S0);                  // A0 = boxed proto
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);           // A1 = boxed "constructor"
        vm.mov(VReg.A2, VReg.S1);                   // A2 = boxed fn
        vm.call("_object_define");
        // [descriptor] prototype.constructor must be non-enumerable per ES spec
        vm.mov(VReg.A0, VReg.S0);                  // A0 = boxed proto
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);           // A1 = boxed "constructor"
        vm.movImm(VReg.A2, 5);                      // attr=5: writable+configurable, not enumerable
        vm.call("_object_set_prop_attr");
        // 4. fn.prototype = boxed prototype (via _closure_prop_set)
        vm.mov(VReg.A0, VReg.S1);                   // A0 = boxed fn
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);           // A1 = boxed "prototype"
        vm.mov(VReg.A2, VReg.S0);                   // A2 = boxed prototype
        vm.call("_closure_prop_set");
        // [test262 13.2-18-1] F.prototype 描述符 = {writable:true, enumerable:false,
        // configurable:false}(attr 1 = 仅 writable)。此前默认 attr 7 → verifyProperty
        // enumerable/configurable 判负。
        vm.mov(VReg.A0, VReg.S1);                   // A0 = boxed fn
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);           // A1 = boxed "prototype"
        vm.movImm(VReg.A2, 1);                      // ATTR_WRITABLE
        vm.call("_closure_prop_set_attr");
        // 5. return boxed prototype
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_key_ck");
        // [TA ctor 元数据] TA 构造器闭包 {0xc105, _ta_ctor_tramp, type@16} 作**值**传递时
        // (`var C = Int8Array` / `ctors[i]`),name/length/BYTES_PER_ELEMENT 无从静态解析,
        // 元数据侧表按 code_ptr 查也只得共享蹦床身份。这里按 type@16 逐型回答:
        // name = 型名、length = 3(规范 TA 构造器 arity)、BYTES_PER_ELEMENT = 元素字节。
        // test262 的 testTypedArray harness 正是经 `ctors[i].name` 组装断言消息、经
        // `TA.BYTES_PER_ELEMENT` 算缓冲尺寸的。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cpg_tactor_ck");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_cpg_plain_key");
        vm.label("_cpg_tactor_ck");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1);          // V0 = 闭包块
        vm.load(VReg.V2, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 0xc105);
        vm.jne("_cpg_plain_key");
        vm.load(VReg.V2, VReg.V0, 8);               // code_ptr
        vm.lea(VReg.V1, "_ta_ctor_tramp");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jne("_cpg_plain_key");
        vm.load(VReg.S2, VReg.V0, 16);              // S2 = TA 类型字节
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);          // key payload
        vm.lea(VReg.V1, vm.asm.addString("BYTES_PER_ELEMENT"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cpg_ta_bpe");
        vm.lea(VReg.V1, vm.asm.addString("length"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cpg_ta_len");
        // 静态 from/of 在 %TypedArray% 上(非各 TA 构造器自有)。ArrayBuffer(0x70)
        // 不继承。miss 路径、两 interned 键,不进热表。
        vm.cmpImm(VReg.S2, 0x70);
        vm.jeq("_cpg_undef");
        vm.lea(VReg.V1, vm.asm.addString("from"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cpg_ta_inherit");
        vm.lea(VReg.V1, vm.asm.addString("of"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cpg_ta_inherit");
        vm.lea(VReg.V1, vm.asm.addString("name"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_cpg_undef");
        for (const [tag, nm] of [
            [0x40, "Int8Array"], [0x41, "Int16Array"], [0x42, "Int32Array"],
            [0x43, "BigInt64Array"], [0x50, "Uint8Array"], [0x51, "Uint16Array"],
            [0x52, "Uint32Array"], [0x53, "BigUint64Array"], [0x54, "Uint8ClampedArray"],
            [0x60, "Float32Array"], [0x61, "Float64Array"],
        ]) {
            const nx = "_cpg_tan_" + tag.toString(16);
            vm.cmpImm(VReg.S2, tag);
            vm.jne(nx);
            vm.lea(VReg.A0, vm.asm.addString(nm));
            vm.call("_js_box_string");
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
            vm.label(nx);
        }
        // ArrayBuffer 等非 TA 型的构造器闭包(type 不在表内):名字未知 → undefined
        vm.jmp("_cpg_undef");
        vm.label("_cpg_ta_inherit");
        // %TypedArray%.from/of 已挂在 intrinsic 侧表;再走 _closure_prop_get 命中侧表,
        // 不会再进本 TA-ctor 分支(intrinsic fnptr 是 _ta_abstract_ctor)。
        vm.call("_ta_intrinsic");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_closure_prop_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_ta_len");
        vm.movImm(VReg.RET, 3);                     // 规范 %TypedArray% 构造器 length
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_ta_bpe");
        // 类型字节 → 元素字节数(与 _ta_elem_size 同表,但那支 helper 收的是 TA 实例指针)
        for (const [sz, tags] of [[1, [0x40, 0x50, 0x54]], [2, [0x41, 0x51]],
            [4, [0x42, 0x52, 0x60]], [8, [0x43, 0x53, 0x61]]]) {
            for (const tag of tags) {
                const nx = "_cpg_tabpe_" + tag.toString(16);
                vm.cmpImm(VReg.S2, tag);
                vm.jne(nx);
                vm.movImm(VReg.RET, sz);
                vm.scvtf(0, VReg.RET);
                vm.fmovToInt(VReg.RET, 0);
                vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
                vm.label(nx);
            }
        }
        vm.jmp("_cpg_undef");
        vm.label("_cpg_plain_key");
        // key 去壳 == addString("name")/addString("length") 地址?
        // (emitBoxedStringKey 经 addString dedup,同址)
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);          // key payload
        vm.lea(VReg.V1, vm.asm.addString("length")); // "length" 串地址
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cpg_len");
        vm.lea(VReg.V1, vm.asm.addString("name"));  // "name" 串地址
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_cpg_ctor_ck");
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        // [W-27] key==="length":同一套闭包脱壳(与 name 路径逐字同形),查 _func_meta_arity。
        // 未登记(匿名普通函数/内建)返 -1 → undefined(不编造 0);>=0 → canonical JS number。
        // 脱壳代码在此复制而非与 name 路径共享:共享需一个跨分支存活的标志寄存器,而本函数
        // 只保了 S0/S1(键与 fn),再占一个 callee-saved 会改热路径栈帧;复制 ~9 条指令更廉价。
        vm.label("_cpg_len");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1);          // V0 = P
        vm.load(VReg.V2, VReg.V0, 0);               // [P]
        vm.cmpImm(VReg.V2, 0xc105); vm.jeq("_cpg_len_clo");
        vm.cmpImm(VReg.V2, 0xa51c); vm.jeq("_cpg_len_clo");
        vm.mov(VReg.A0, VReg.V0);                   // 裸函数指针:code_ptr = P
        vm.jmp("_cpg_len_lk");
        vm.label("_cpg_len_clo");
        vm.load(VReg.A0, VReg.V0, 8);               // 闭包:code_ptr = [P+8]
        vm.label("_cpg_len_lk");
        vm.call("_func_meta_arity");                // RET = arity(>=0);-1 = 未登记
        vm.movImm(VReg.V1, -1);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpg_undef");
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);                  // 裸 int → canonical float64 位模式
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        // Inherited Function.prototype (and further) for fn.prop GET.
        // name/length stay on the metadata path above. x64: tag extract uses V2
        // (V0≡RET). _object_get returns the raw TYPE_GETTER marker; _maybe_getter
        // invokes with this=fn.
        vm.label("_cpg_ctor_ck");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.lea(VReg.V1, vm.asm.addString("constructor"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_cpg_proto");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 0xc105); vm.jeq("_cpg_ctor_clo");
        vm.cmpImm(VReg.V2, 0xa51c); vm.jeq("_cpg_ctor_clo");
        vm.mov(VReg.A0, VReg.V0);
        vm.jmp("_cpg_ctor_lk");
        vm.label("_cpg_ctor_clo");
        vm.load(VReg.A0, VReg.V0, 8);
        vm.label("_cpg_ctor_lk");
        vm.call("_func_meta_find");
        vm.cmpImm(VReg.RET, 1); vm.jeq("_cpg_ctor_genfunc");
        vm.cmpImm(VReg.RET, 2); vm.jeq("_cpg_ctor_asyncfunc");
        vm.cmpImm(VReg.RET, 3); vm.jeq("_cpg_ctor_asyncgenfunc");
        vm.jmp("_cpg_proto");
        vm.label("_cpg_ctor_genfunc");
        vm.call("_ensure_genfunc_ctor");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_ctor_asyncfunc");
        vm.call("_ensure_asyncfunc_ctor");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_ctor_asyncgenfunc");
        // This also installs the configurable @@toStringTag on the existing
        // AsyncGeneratorFunction prototype before exposing its constructor.
        vm.call("_ensure_asyncgenfunc_tag_proto");
        vm.call("_ensure_asyncgenfunc");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_proto");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_getPrototypeOf");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cpg_undef");
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFB);
        vm.jeq("_cpg_undef");
        vm.cmpImm(VReg.V2, 0x7FFA);
        vm.jeq("_cpg_undef");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_object_get");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpg_undef");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpg_undef");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // caller/arguments 读拦截落点(见 _cpg_miss 头部按键分流)。抛错即解退,
        // 无需 epilogue。
        vm.label("_cpg_forbidden");
        vm.lea(VReg.A0, vm.asm.addString("'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        // _closure_prop_set(A0=fn, A1=key, A2=val) -> val(赋值表达式之值)。
        // [I6] 函数值 name/length 的 [[Set]] 守卫:规范形状恒 {writable:false,
        // enumerable:false, configurable:true}(_ogopd_fn 硬编),属性**有效存在**
        // (_closure_prop_get 非 undefined——侧表命中或元数据回落)时赋值静默忽略
        // (sloppy 语义返 RHS;asm.js 无 strict 上下文,不抛 TypeError,与 _object_set
        // 的 _object_set_wcheck「sloppy 静默」同形——strict 抛为残差)。此前无守卫:
        // fn.name="x" 落侧表遮蔽元数据/规范值,test262 verifyProperty 的 isWritable
        // 探针(写后值变)恒败。编译期登记站点(emitBuiltinMethodRefClosureMeta /
        // emitRegExpMethodClosure / emitDateProtoMethodEntry / _ta_intrinsic 等)不受影响:
        // 新闭包 code_ptr 是运行时蹦床标签(_aref_generic 等),函数元数据侧表无登记 →
        // _closure_prop_get → undefined → 放行。删除后重赋亦放行(墓碑 → undefined,
        // 且先清墓碑槽使新值按默认 attr=7 落回,符合 ES 删后重建语义)。
        vm.label("_closure_prop_set");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0); // assignment mode: sloppy [[Set]]
        vm.jmp("_cps_entry");

        // Strict PutValue entry used by member assignments in strict code.
        // Keep the closure side-table policy in one body, but carry the mode
        // in this frame so nested calls cannot confuse it with the value/key.
        vm.label("_closure_prop_set_strict");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm(VReg.V0, 2);
        vm.store(VReg.SP, 0, VReg.V0); // strict assignment mode
        vm.jmp("_cps_entry");

        vm.label("_cps_entry");
        vm.mov(VReg.S0, VReg.A1); // key
        vm.mov(VReg.S1, VReg.A2); // val
        vm.mov(VReg.S2, VReg.A0); // fn
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_cps_str_key");
        // Unboxed/interned key: payload-compare caller/arguments (same as GET).
        // Skipping this jumped _cps_set → proto-walk Function.prototype.caller
        // TYPE_GETTER → callIndirect smashed x64 V0≡RET (method.caller = {}).
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.lea(VReg.V1, vm.asm.addString("caller"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cps_forbidden");
        vm.lea(VReg.V1, vm.asm.addString("arguments"));
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_cps_forbidden");
        vm.jmp("_cps_set");
        vm.label("_cps_str_key");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        // 内容指针必须进 callee-saved:x64 V3≡A4≡R8,跨 _strcmp 即失效,
        // 第二次 strcmp 拿垃圾当键,常误判成 "length" → 有元数据的函数赋值被
        // _cps_ignored 静默丢掉(test262 harness 的 assert.sameValue=fn 全失效)。
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cps_nl_name");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cps_chk_forbidden");              // 非 name/length → 查 caller/arguments
        vm.label("_cps_nl_len");
        vm.lea(VReg.S3, vm.asm.addString("length"));
        vm.jmp("_cps_nl");
        vm.label("_cps_nl_name");
        vm.lea(VReg.S3, vm.asm.addString("name"));
        vm.label("_cps_nl");
        // 键换数据段字面量(_closure_prop_get 的元数据回落按 payload 地址比较)
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S3, VReg.V1);      // 装箱字面量键
        vm.call("_closure_prop_get");          // 侧表 → 元数据回落(墓碑 → undefined)
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cps_name_length_missing");
        // name/length are non-writable.  Sloppy assignment is ignored; strict
        // assignment must throw, matching OrdinarySet's [[Set]] result.
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 2);
        vm.jeq("_cps_throw_readonly");
        vm.jmp("_cps_ignored");
        vm.label("_cps_name_length_missing");
        // 有效不存在:若侧表留有墓碑槽(曾删除),先移除,使下方常规写以默认 attr=7
        // 重建条目(否则 _object_set 命中路径的 writable 守卫见 0x80 无写位 → 静默丢弃,
        // 删后重赋永不生效)。
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S3, VReg.V1);
        vm.call("_closure_prop_tombstoned");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cps_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_closure_props_find");        // 墓碑 ⟹ 侧表必在 → 非 undefined
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S3, VReg.V1);
        vm.call("_object_delete");             // 移除墓碑槽(装箱布尔返回值弃)
        // [test262] caller/arguments 赋值拦:Function.prototype 上的 %ThrowTypeError%
        // setter(ES 18.2.1.1.3/1.4)。_closure_prop_define(defineProperty 路由)不经此,
        // 故 defineProperty(fn,"caller",{value:1}) 的 own-prop 覆盖仍有效(侧表命中
        // 读回,forbidden-ext 族依赖)。
        vm.label("_cps_chk_forbidden");
        vm.mov(VReg.A0, VReg.S0);             // A0 = key(装箱串)
        vm.call("_getStrContent");
        vm.mov(VReg.S3, VReg.RET);            // S3 = 内容指针(x64 V3 跨 _strcmp 失效)
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("caller"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cps_forbidden");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("arguments"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cps_set");
        vm.label("_cps_forbidden");
        vm.lea(VReg.A0, vm.asm.addString("'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_cps_set");
        // Own side-table hit → existing _object_set (writable/accessor).
        // Miss → walk Function.prototype like OrdinarySet. Getter-only inherit
        // rejects (4-596: bound fn.prop = x must not create own).
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cps_proto_walk");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cps_own_set");
        vm.label("_cps_proto_walk");
        // 函数实例的 `F.prototype = …` 必须落在 F 的自有侧表槽上;不能沿
        // Function.prototype 链命中用户安装的 prototype 访问器(13.2-18-1)。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cps_proto_walk_chain");
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_cps_proto_walk_ctor");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_cps_proto_walk_ctor");
        vm.jmp("_cps_proto_walk_chain");
        vm.label("_cps_proto_walk_ctor");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S2, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 0xc105);
        vm.jne("_cps_proto_walk_chain");
        vm.load(VReg.V2, VReg.V0, 8);
        vm.lea(VReg.V1, "_aref_generic");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_cps_proto_walk_chain");
        vm.lea(VReg.V1, "_aref_static_tramp");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_cps_proto_walk_chain");
        vm.lea(VReg.V1, "_bound_tramp");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_cps_proto_walk_chain");
        vm.jmp("_cps_own_set");
        vm.label("_cps_proto_walk_chain");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_object_getPrototypeOf");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cps_own_set");
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFB);
        vm.jeq("_cps_own_set");
        vm.cmpImm(VReg.V2, 0x7FFA);
        vm.jeq("_cps_own_set");
        vm.mov(VReg.S3, VReg.RET); // prototype
        // %Array.prototype% is itself an Array exotic.  Its named accessors
        // live in the closure side table; _object_get(array,key) would invoke
        // the getter and discard the raw TYPE_GETTER marker needed by [[Set]].
        vm.shrImm(VReg.V2, VReg.S3, 48);
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jne("_cps_proto_lookup");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cps_own_set");
        vm.mov(VReg.S3, VReg.RET);
        vm.label("_cps_proto_lookup");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_object_get");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cps_own_set");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cps_own_set");
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_cps_own_set");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jlt("_cps_own_set");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jge("_cps_own_set");
        vm.load(VReg.V1, VReg.RET, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER);
        vm.jne("_cps_own_set");
        vm.load(VReg.V0, VReg.RET, 16); // setter
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cps_ignored");
        vm.mov(VReg.A5, VReg.S2);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_cps_acc_call");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_cps_acc_call");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_cps_acc_clo");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jne("_cps_acc_call");
        vm.label("_cps_acc_clo");
        // Accessor bodies may close over lexical state.  Preserve the closure pointer in S0
        // for the callee before extracting its code pointer; passing the property key in S0
        // made captured setters dereference string storage as a closure (SIGSEGV/SIGBUS).
        vm.mov(VReg.S0, VReg.V0);
        vm.load(VReg.V0, VReg.S0, 8);
        vm.label("_cps_acc_call");
        // x64 V0≡RET: setCallArgcImm scratch-clobbers V0. Hold fn in V1
        // (same as _maybe_getter_call).
        vm.mov(VReg.V1, VReg.V0);
        vm.setCallArgcImm(1, VReg.V0, VReg.V2);
        vm.callIndirect(VReg.V1);
        vm.jmp("_cps_ignored");
        vm.label("_cps_own_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_closure_props_ensure"); // A0=fn → RET=props(装箱)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 2);
        vm.jeq("_cps_own_set_strict");
        vm.call("_object_set");
        vm.mov(VReg.RET, VReg.S1); // 返回被赋值
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_cps_own_set_strict");
        vm.call("_object_set_strict");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_cps_throw_readonly");
        vm.lea(VReg.A0, this.vm.asm.addString("Cannot assign to read only property"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_cps_ignored");
        vm.mov(VReg.RET, VReg.S1);             // 返回 RHS(sloppy 赋值表达式值不变)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // [I6] _closure_prop_define(A0=fn, A1=key, A2=val) -> val。[[DefineOwnProperty]]
        // 语义(defineProperty 路由,经 _object_set_fnprops 的 define 标志分流到此):
        // **不受** name/length 不可写守卫阻(ES:DefineOwnProperty 与 writable 无关,
        // defineProperty(fn,"length",{value:1}) 覆盖必须生效——fixture fn-name-length-
        // descriptor / function-name-reflect 的 defineProperty 覆盖读回依赖此路)。但若
        // name/length 曾被删除(墓碑槽在侧表),须先清墓碑:否则 _closure_prop_get 的
        // 墓碑位使读恒 undefined,defineProperty 的覆盖值读不回。落值经 _object_define
        // (define 标志 → found 路径直覆值、不查原型链访问器、不受 writable 位阻)。
        vm.label("_closure_prop_define");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A1); // key
        vm.mov(VReg.S1, VReg.A2); // val
        vm.mov(VReg.S2, VReg.A0); // fn
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_cpdf_set");                   // 非字符串键 → 直接 define 落侧表
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S3, VReg.RET);             // 同 _closure_prop_set:x64 V3 跨 call 失效
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cpdf_nl_name");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cpdf_set");                   // 非 name/length → 直接 define 落侧表
        vm.label("_cpdf_nl_len");
        vm.lea(VReg.S3, vm.asm.addString("length"));
        vm.jmp("_cpdf_nl");
        vm.label("_cpdf_nl_name");
        vm.lea(VReg.S3, vm.asm.addString("name"));
        vm.label("_cpdf_nl");
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S3, VReg.V1);
        vm.call("_closure_prop_tombstoned");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cpdf_set");                   // 无墓碑 → 直接 define 覆写
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_closure_props_find");        // 墓碑 ⟹ 侧表必在
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S3, VReg.V1);
        vm.call("_object_delete");             // 清墓碑槽(新定义以默认 attr 重建)
        vm.label("_cpdf_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_closure_props_ensure");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_define");             // define 语义:found 直覆、miss 追加
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // [Date 一等值] _closure_prop_set_attr(A0=fn, A1=key, A2=attr):给闭包属性侧表里
        // 的某键落属性特性位。_closure_prop_set 只 _object_set 落值(侧表 props 是普通对象,
        // 默认 attr=7 全真),gOPD(fn,key) 递归描述该 props 对象时会如实读出 attr 字节 →
        // 不落 attr 则 gOPD(Date,"now") 误报 enumerable:true、gOPD(Date,"prototype") 全真。
        // 用法:_closure_prop_set 落值**之后**调本 helper 落 attr(顺序不可反:
        // _object_set_prop_attr 会 materialize flags 并置 EXT_HASFLAGS,值须先就位)。
        vm.label("_closure_prop_set_attr");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A1); // key
        vm.mov(VReg.S1, VReg.A2); // attr
        vm.call("_closure_props_ensure"); // A0=fn → RET=props(装箱)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_set_prop_attr");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // [I5] _js_length_dyn(A0=任意值)→ RET=裸整数长度。契约同 _js_length(裸整数),
        // 差异仅在函数值(0x7FFF):**先**查闭包属性侧表 "length"——内建方法值闭包
        // (Array.prototype.<m>、arr.<m>、"s".<m> 等取值形态)code_ptr 全共享 _aref_generic,
        // 按 code_ptr 登记的函数元数据侧表无法区分逐方法身份,规范 length 由编译期
        // _closure_prop_set 逐闭包落在侧表;命中 → canonical number 转裸整数返回。
        // miss(用户函数/未挂侧表的内建)→ _closure_prop_get 自身回落元数据 arity,仍命中
        // 即返;彻底无值(undefined)才落 _js_length 原路(其 _js_length_func 把 -1 归 0,
        // 与改前逐字节同行为)。非函数值形态直走 _js_length,逐字节等价。
        // 消费方:编译期未知接收者 .length 读位(members.js,静态 String/Array 等不经此)。
        // [I6] 契约变更:RET 由裸整数改为**装箱 JS 值**(canonical number 位模式,或墓碑
        // 情形的装箱 undefined——函数值 length 删除后读必须 undefined,不得被 _jsld_plain
        // 的 _js_length 元数据 arity 复活)。调用点(members.js 单一站点)相应不再做
        // scvtf/fmovToInt 转换;非函数路径内部自转换,逐值语义与改前等价。
        vm.label("_js_length_dyn");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // 保存原值
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_jsld_maybe_args");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jne("_jsld_plain"); // 非函数 → 原路
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1); // 装箱字符串键 "length"(数据段字面量,与
        //                                   _closure_prop_get 的 _cpg_key_ck 地址比较同源)
        vm.call("_closure_prop_get");     // RET = canonical number / undefined(墓碑 → undefined)
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);       // undefined → 侧表+元数据皆无值(或墓碑)
        vm.jne("_jsld_hit");
        // [I6] undefined 二态判别:墓碑(曾删除)→ 装箱 undefined 直返;从未存在 →
        // 原路 _js_length(其 _js_length_func 把 -1 归 0,改前行为不变)。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_closure_prop_tombstoned");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_jsld_plain");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_jsld_hit");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_number_coerce");        // RET = float64 位(用户 defineProperty 落装箱整数亦归一)
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.RET, 0);           // canonical number → 裸整数(同 _js_length_object 尾段)
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);        // 裸整数 → canonical number 位(新契约:装箱值)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_jsld_maybe_args");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1); // raw (not V0: x64 V0≡RET)
        vm.loadByte(VReg.V1, VReg.V2, 1);
        vm.andImm(VReg.V1, VReg.V1, 32); // ARR_IS_ARGUMENTS
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_jsld_plain");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.V0, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1);
        vm.call("_closure_prop_get");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_jsld_plain"); // no override → header length
        // return as-is (string / number / whatever was assigned)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_jsld_plain");
        // 普通对象 .length 是普通属性读:miss → undefined(不可 ToNumber→0)。
        // _js_length_object 把 undefined coerce 成 0 供 LengthOfArrayLike;属性读须区分
        // (shift A2_T1:`{}.length === undefined`)。
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_jsld_object_prop");
        // Naked classinfo (type=3, high16=0): static length method/get/set/field
        // overwrites the builtin number. _js_length_object ToNumber-coerces that
        // own value (function → garbage int). Same as boxed 0x7FFD: return the
        // property as-is (method / getter result / setter-only undefined).
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_jsld_plain_js_length");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_jsld_plain_js_length");
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_jsld_plain_js_length");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_jsld_plain_js_length");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION / classinfo
        vm.jeq("_jsld_object_prop");
        vm.label("_jsld_plain_js_length");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_length");            // RET = 裸整数
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);        // canonical number 位(新契约:装箱值)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_jsld_object_prop");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.V0, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1);
        vm.call("_object_get");
        // 普通属性 Get 须触发 accessor(o.length 与 o["length"] 对齐)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFB); // undefined → 属性 miss
        vm.jeq("_jsld_obj_undef");
        // Hit: return stored value (Infinity/1.5/"foo"). Do not fcvtzs:
        // x64 cvttsd2si(+Inf)=INT64_MIN → push A2_T2 length !== Infinity.
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_jsld_obj_undef");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // [I6] _closure_prop_tombstoned(A0=fn 任意形, A1=装箱键) -> RET=裸 0/1(0x80/0)。
        // 判侧表该键条目是否带墓碑位 ATTR_FN_DELETED(_closure_prop_del 所落)。供带
        // 「miss → 静态/元数据回落」的读位区分「从未存在」(可回落)与「存在过已删除」
        // (须抑制回落、规范读 undefined):_js_length_dyn 的 _jsld_plain 回落、members.js
        // 静态 fn.name/fn.length 读的编译期值回落。_closure_prop_get/_fn_has_own/_prop_in/
        // _ogopd_fn 无需本 helper——它们直接以 _closure_prop_get 的 undefined 为「不存在」。
        vm.label("_closure_prop_tombstoned");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // fn
        vm.mov(VReg.S1, VReg.A1); // 键
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpt_false");             // 无侧表 → 无墓碑
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.S2, VReg.RET, VReg.V1); // raw props
        vm.load(VReg.S3, VReg.S2, 8);       // count
        vm.movImm(VReg.S4, 0);              // idx
        vm.label("_cpt_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_cpt_false");
        vm.load(VReg.V2, VReg.S2, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cpt_hit");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_cpt_loop");
        vm.label("_cpt_hit");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_get_attr");        // RET = attr 字节
        vm.andImm(VReg.RET, VReg.RET, ATTR_FN_DELETED); // 0x80 / 0(消费方 cmpImm 0 判别)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpt_false");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // [I6] _closure_prop_del(A0=fn 任意形, A1=键) -> RET=装箱布尔(delete 表达式值)。
        // 函数值(闭包)[[Delete]]:
        //   name/length → 规范 configurable:true,delete 恒返 true 且须**永久移除**:
        //     值双源并存——闭包属性侧表(编译期登记/用户写)+ 函数元数据侧表(按 code_ptr,
        //     _func_meta_name/_func_meta_arity)——仅删侧表条目会被元数据回落复活。故删除
        //     落墓碑槽:value=undefined、attr=ATTR_FN_DELETED(0x80);_closure_prop_get 见
        //     墓碑位直返 undefined 不落元数据。属性有效不存在(双源皆无/已墓碑)→ 不动作返
        //     true(规范 delete-miss=true)。
        //   其余键 → 侧表 props 普通对象 _object_delete(尊重 per-property configurable,
        //     装箱布尔透传:不可配置 → false);无侧表 → true。
        vm.label("_closure_prop_del");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // fn
        // 键归一(数值键 → 字符串,同 _odel_key_ok 形态)
        vm.shrImm(VReg.V1, VReg.A1, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_cpd_key_str");
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_cpd_key_done");
        vm.label("_cpd_key_str");
        vm.mov(VReg.S1, VReg.A1);
        vm.label("_cpd_key_done");
        // name/length 判别(同 _fn_has_own 的 strcmp 形态)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET);          // 内容指针
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cpd_name");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_cpd_len");
        // 其余键:侧表常规删除
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpd_true");                // 无侧表 → delete-miss → true
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_delete");          // 装箱布尔透传
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_cpd_name");
        vm.lea(VReg.S2, vm.asm.addString("name")); // S2 复用为字面量载荷(内容指针不再用)
        vm.jmp("_cpd_nl");
        vm.label("_cpd_len");
        vm.lea(VReg.S2, vm.asm.addString("length"));
        vm.label("_cpd_nl");
        // 有效存在判定:_closure_prop_get(侧表 → 元数据;墓碑 → undefined)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S2, VReg.V1);
        vm.call("_closure_prop_get");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpd_true");                // 有效不存在(含已墓碑)→ true
        // 侧表条目若被 defineProperty 落成不可配置(如 {configurable:false} 覆盖),
        // delete 须拒(sloppy 返 false,同 _odel_hit 的 configurable 守卫)。元数据提供
        // (侧表无条目,attr=0x100 哨兵)的规范 name/length 恒 configurable:true → 放行。
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S2, VReg.V1);
        vm.call("_closure_prop_attr");      // RET = attr 字节(0x100=侧表无此条目)
        vm.cmpImm(VReg.RET, 0x100);
        vm.jeq("_cpd_cfg_ok");
        vm.andImm(VReg.V0, VReg.RET, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_cpd_false");               // 不可配置 → 拒删,返 false
        vm.label("_cpd_cfg_ok");
        // 落墓碑:ensure 侧表 → 写 value undefined → attr=ATTR_FN_DELETED_TOMB(0x84)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_ensure");   // RET = 装箱 props
        vm.mov(VReg.S0, VReg.RET);          // S0 = props(fn 不再需要)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S2, VReg.V1);
        vm.lea(VReg.A2, "_js_undefined");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.call("_object_set");             // 追加/覆写墓碑值(旧槽 attr 默认 7 → 写生效)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S2, VReg.V1);
        vm.movImm(VReg.A2, ATTR_FN_DELETED_TOMB);
        vm.call("_object_set_prop_attr");   // flags[idx]=0x84(副作用 materialize flags;
        //                                   保 CONFIGURABLE 位使 _cps_set 的 _object_delete 可清)
        vm.label("_cpd_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_cpd_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // [I6] _closure_prop_attr(A0=fn 任意形, A1=装箱键) -> RET=侧表条目 attr 字节;
        // 侧表无此条目(或无侧表)→ 0x100 哨兵(任何真实 attr ≤ 0x87,不会撞)。供
        // _closure_prop_del 判侧表 name/length 条目可配置性(defineProperty 覆盖落过的
        // 非默认 attr 须被尊重:configurable:false → delete 返 false)。扫描体与
        // _closure_prop_tombstoned 同形(命中 → _object_get_attr;miss → 哨兵)。
        vm.label("_closure_prop_attr");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // fn
        vm.mov(VReg.S1, VReg.A1); // 键
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_cpa_absent");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.S2, VReg.RET, VReg.V1); // raw props
        vm.load(VReg.S3, VReg.S2, 8);       // count
        vm.movImm(VReg.S4, 0);              // idx
        vm.label("_cpa_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_cpa_absent");
        vm.load(VReg.V2, VReg.S2, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_cpa_hit");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_cpa_loop");
        vm.label("_cpa_hit");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_get_attr");        // RET = attr 字节(flags_ptr=0 → ATTR_DEFAULT)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_cpa_absent");
        vm.movImm(VReg.RET, 0x100);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // 创建新对象
    // _object_new() -> obj (raw pointer)
    // _object_new_sized(bytes) -> obj (raw pointer)  按需容量（编译期已知属性数时用）
    // _object_new_raw() -> obj (raw pointer)  __proto__ 恒 0(内部专用:Object.prototype 自身)
    //
    // [W-B] 原型链链接。_object_new/_object_new_sized 把新对象的 __proto__ 链到**单例**
    // Object.prototype——与 `Object.prototype` 属性读返回的对象是同一个(槽
    // _nsobj_object_proto,首次访问由 _object_proto_ensure 惰性建、填 ctor 闭包
    // _nsobj_object)。S2 = 链接标志(1=链 Object.prototype,0=保持 null)。_alloc 保 S0-S3,
    // 故 S2 跨 _alloc 存活。Object.prototype 自身经 _object_new_raw 建(__proto__=0,防自环);
    // Object.create(null) 由 _object_create 在 new 之后**覆写** __proto__=0,语义不受影响。
    generateObjectNew() {
        const vm = this.vm;

        vm.label("_object_new");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        // 默认初始容量 8（属性区可自动增长，无需大固定块）
        vm.movImm(VReg.S1, 8);
        vm.movImm(VReg.S2, 1); // 链接 Object.prototype
        vm.jmp("_object_new_do");

        vm.label("_object_new_sized");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        // A0 = 请求字节数（旧头 24 + 每属性 16）。换算成初始容量，下限 4。
        vm.subImm(VReg.S1, VReg.A0, 24);
        vm.cmpImm(VReg.S1, 64);
        vm.jge("_object_new_sized_cap");
        vm.movImm(VReg.S1, 64);
        vm.label("_object_new_sized_cap");
        vm.shrImm(VReg.S1, VReg.S1, 4); // /16 -> 初始容量
        vm.movImm(VReg.S2, 1); // 链接 Object.prototype
        vm.jmp("_object_new_do");

        vm.label("_object_new_raw");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm(VReg.S1, 8);
        vm.movImm(VReg.S2, 0); // 不链接(__proto__ = 0)
        vm.jmp("_object_new_do");

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

        // [W-B] 链接单例 Object.prototype(仅 S2 != 0)。_object_proto_ensure 首次建并
        // 存槽;后续直接读槽。S0/S1/S2 跨其存活(prologue 保 S0-S3)。
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_object_new_nolink");
        vm.call("_object_proto_ensure"); // RET = 装箱 Object.prototype
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1); // V0 = 裸 proto
        vm.store(VReg.S0, 16, VReg.V0);
        vm.label("_object_new_nolink");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // [W-B] 单例 Object.prototype 惰性物化 + ctor 闭包。
    // _object_proto_ensure() -> boxed Object.prototype(0x7FFD)。无参;保 S0/S1/S2/S3。
    // 首次调用(首个 _object_new)建:
    //   - _nsobj_object_proto:普通对象(__proto__=0,经 _object_new_raw 防自环),属性 =
    //     方法值闭包({magic,_aref_generic,helper},挂 .name/.length;含 Annex B legacy 四方法)
    //     + constructor = 下方 ctor 闭包(与 W-A2 的 OBJECT_PROTO_METHODS 逐字同 helper 同 attr 5)。
    //   - _nsobj_object:构造器闭包 {magic, _object_ctor_call}(使 `({}).constructor ===
    //     Object` 恒等——编译器 W-A2 物化读到这两个槽,直接复用,不再新建)。
    // 两者都在数据段 → GC 保守扫描即根;且与 W-A2 `Object.prototype` 属性读返回同一对象。
    generateObjectProtoEnsure() {
        const vm = this.vm;
        // 数据槽(_reEnsureSlot 同款命名;编译器侧 _reEnsureSlot 看到已登记即跳过)。
        vm.asm.addDataLabel("_nsobj_object_proto");
        vm.asm.addDataQword(0);
        vm.asm.addDataLabel("_nsobj_object");
        vm.asm.addDataQword(0);
        // Compiler-side Object materialisation uses a process-global ready
        // bit so dynamic fragments can share the host singleton slots and
        // avoid rebuilding the constructor/prototype on every eval. Declare
        // it beside the runtime-owned slots; `_reEnsureSlot` will observe the
        // existing label when the compiler emits its fragment references.
        vm.asm.addDataLabel("_nsobj_object_ready");
        vm.asm.addDataQword(0);

        vm.label("_object_proto_ensure");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.lea(VReg.V0, "_nsobj_object_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ope_done"); // 已建 → 直接返槽值
        // 1. proto = _object_new_raw(__proto__=0)。S0 = 裸 proto。
        vm.call("_object_new_raw");
        vm.mov(VReg.S0, VReg.RET);
        // 2. 装箱 + 存槽。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.lea(VReg.V1, "_nsobj_object_proto");
        vm.store(VReg.V1, 0, VReg.V0);
        // 3. ctor 闭包 {magic, _object_ctor_call};S1 = 裸 closure;S2 = 装箱 ctor。
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        vm.store(VReg.S1, 0, VReg.V1);
        vm.lea(VReg.V1, "_object_ctor_call");
        vm.store(VReg.S1, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_box_function"); // RET = 装箱 ctor
        vm.lea(VReg.V1, "_nsobj_object");
        vm.store(VReg.V1, 0, VReg.RET);
        vm.mov(VReg.S2, VReg.RET);
        // 4. proto 方法落位(与 W-A2 OBJECT_PROTO_METHODS 同 helper 同 arity)。
        //    每方法:24B 闭包 {0xc105, _aref_generic, helper} + .name/.length + proto
        //    属性(attr 5)。S3 = 装箱方法闭包(跨 call 保;各 helper 均保 S0-S3)。
        const emitProtoMethod = (mname, helperLabel, arity) => {
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");
            vm.mov(VReg.S3, VReg.RET);
            vm.movImm(VReg.V1, 0xc105);
            vm.store(VReg.S3, 0, VReg.V1);
            vm.lea(VReg.V1, "_aref_generic");
            vm.store(VReg.S3, 8, VReg.V1);
            vm.lea(VReg.V1, helperLabel);
            vm.store(VReg.S3, 16, VReg.V1);
            vm.mov(VReg.A0, VReg.S3);
            vm.call("_js_box_function"); // RET = 装箱闭包
            vm.mov(VReg.S3, VReg.RET);
            // .name = mname
            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, vm.asm.addString("name"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.lea(VReg.A2, vm.asm.addString(mname));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A2, VReg.A2, VReg.V1);
            vm.call("_closure_prop_set");
            // .length = arity
            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, vm.asm.addString("length"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, arity);
            vm.scvtf(0, VReg.A2);
            vm.fmovToInt(VReg.A2, 0);
            vm.call("_closure_prop_set");
            // proto[mname] = 装箱闭包
            vm.mov(VReg.A0, VReg.S0); // 裸 proto
            vm.lea(VReg.A1, vm.asm.addString(mname));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.mov(VReg.A2, VReg.S3);
            vm.call("_object_set");
            // attr 5(writable|configurable,enumerable 关,规范 17 节)
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString(mname));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, 5);
            vm.call("_object_set_prop_attr");
        };
        emitProtoMethod("hasOwnProperty", "_aref_obj_hasOwn", 1);
        emitProtoMethod("valueOf", "_aref_obj_valueOf", 0);
        emitProtoMethod("toString", "_object_proto_toString", 0);
        emitProtoMethod("toLocaleString", "_object_proto_toLocaleString", 0);
        emitProtoMethod("isPrototypeOf", "_is_prototype_of", 1);
        emitProtoMethod("propertyIsEnumerable", "_object_propertyIsEnumerable", 1);
        // [Annex B] legacy accessor 安装/查找(与 W-A2 OBJECT_PROTO_METHODS 同步)
        emitProtoMethod("__defineGetter__", "_aref_obj_defineGetter", 2);
        emitProtoMethod("__defineSetter__", "_aref_obj_defineSetter", 2);
        emitProtoMethod("__lookupGetter__", "_aref_obj_lookupGetter", 1);
        emitProtoMethod("__lookupSetter__", "_aref_obj_lookupSetter", 1);
        // [__proto__] accessor property: {get,set,enumerable:false,configurable:true}
        // TYPE_GETTER block (24B) stored as own property on Object.prototype.
        // _object_define bypasses setter dispatch so the block is stored as raw data;
        // subsequent reads/writes will trigger _maybe_getter / _object_set_acc_dispatch.
        {
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");             // RET = raw 24B block
            vm.mov(VReg.V1, VReg.RET);     // V1 = TYPE_GETTER block pointer (must preserve S0-S3)
            vm.movImm(VReg.V0, 60);        // TYPE_GETTER
            vm.store(VReg.V1, 0, VReg.V0); // type@0 = 60
            vm.lea(VReg.V0, "_object_proto_getter");
            vm.store(VReg.V1, 8, VReg.V0); // getter@8
            vm.lea(VReg.V0, "_object_proto_setter");
            vm.store(VReg.V1, 16, VReg.V0);// setter@16
            // proto["__proto__"] = TYPE_GETTER block (define 语义)
            vm.mov(VReg.A0, VReg.S0);      // A0 = raw proto
            vm.lea(VReg.A1, vm.asm.addString("__proto__"));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V0);// A1 = boxed "__proto__" key
            vm.mov(VReg.A2, VReg.V1);      // A2 = TYPE_GETTER block (raw, will be stored as-is)
            vm.call("_object_define");     // Define (not set) to avoid triggering accessor dispatch
            // attr 4 = configurable, non-enumerable (__proto__ is not enumerable)
            vm.mov(VReg.A0, VReg.S0);      // A0 = raw proto
            vm.lea(VReg.A1, vm.asm.addString("__proto__"));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V0);
            vm.movImm(VReg.A2, 4);         // ATTR_CONFIGURABLE
            vm.call("_object_set_prop_attr");
        }
        // 5. proto.constructor = ctor(装箱)。规范 {w:true,e:false,c:true}=attr 5。
        // 此前只 _object_set(默认 attr 7)→ 未物化 Object 的 for-in 会漏出 "constructor"。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 5);
        vm.call("_object_set_prop_attr");
        // 6. ctor 闭包属性:name/length/prototype(W-A2 完整物化前先给最小反射面;
        //    编译器 W-A2 物化时会幂等重落并追加静态方法)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.A2, vm.asm.addString("Object"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_closure_prop_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 1);
        vm.scvtf(0, VReg.A2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_closure_prop_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.V0, "_nsobj_object_proto");
        vm.load(VReg.A2, VReg.V0, 0); // 装箱 proto
        vm.call("_closure_prop_set");
        vm.label("_ope_done");
        vm.lea(VReg.V0, "_nsobj_object_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
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
        vm.jeq("_object_get_array");
        // 字符串(0x7FFC):ES 里字符串**是**属性容器(索引 + length),此前落下方
        // "非对象 → undefined",故凡是接收者未被编译期静态推断为 String 的读全错:
        // `function f(x){return x["1"]}; f("abc")` / `String("xy")["1"]` / 装箱串的
        // `.length` 一律 undefined。走冷分支 _object_get_string 按 ES 语义路由。
        // (编译器对**静态可知**的字符串接收者已直编 _str_index_char/_js_length,
        //  不经此处;本分支只服务动态/未知接收者,不动既有快路字节。)
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_object_get_string");

        // 非法/非对象类型（数组/字符串/数字…），安全返回 undefined(装箱,非裸 0)
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // Naked / wrongly-0x7FFD-tagged closure (magic 0xc105/0xa51c). Low
        // byte 0x05 aliases TYPE_SET — full-word check then box as 0x7FFF.
        // Root of `class C extends Promise` → C.resolve undefined: proto walk
        // used to 0x7FFD-box the Promise ctor; tag_ok then treated it as Set.
        vm.label("_object_get_fn_raw");
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.S0, VReg.S0, VReg.V1);
        // 函数值属性读:委托 _closure_prop_get(fn, key)(其内查侧表 → 普通对象 _object_get,
        // 无递归——props 是普通对象)。
        vm.label("_object_get_fnprops");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_get_raw");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_object_get_fnprops_done");
        // No own side-table key: retain metadata and Function.prototype
        // fallback behaviour from the full helper.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_get");
        // A function's own closure side table is only the first step of
        // OrdinaryGet.  On a miss, continue through Function.prototype (and
        // then Object.prototype) so inherited @@isConcatSpreadable and other
        // properties are observable.
        vm.store(VReg.SP, 0, VReg.RET);
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_object_get_fnprops_done");
        vm.call("_ensure_function_proto");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.label("_object_get_fnprops_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // 数组属性读:委托 _subscript_get(裸数组指针 + 原键)——其内按 ES 语义分派:
        // 规范数值索引键(a["0"]、{0:x} 解构的 "0" 键)→ 元素读;"length" → 长度;
        // 其余具名键 → 属性侧表(.raw 等,同 _closure_prop_get);miss 且非索引 →
        // _nsobj_array_proto(0x7FFD)上 _object_get。索引 hole 保持 undefined。
        // 与 _object_set 的 _object_set_array 写侧路由对称(同一 _canonical_array_index 裁决)。
        // 传**脱壳**指针:即便块类型字节被损坏落到 _subscript_get_object,那里回调
        // _object_get 也是高16=0 的裸指针路径,不会再回到本分支(无递归环)。
        vm.label("_object_get_array");
        // Symbol 键 → 数组侧表(_closure_prop_get)。此前直接 notfound 导致
        // IsConcatSpreadable 读不到 arr[@@isConcatSpreadable](gOPD/赋值已落侧表)。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_get_array_sym");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_subscript_get");       // RET = 元素/侧表值 或 undefined
        // 具名键 miss → Array.prototype 自有方法(0x7FFD,emitArrayCtorObject 已物化)。
        // 规范索引 hole 保持 undefined(不去 prototype 上找 "0")。槽为 0 则跳过,
        // 不调 _ensure_array_proto(会分配空 TYPE_OBJECT 盖掉以后的真 prototype)。
        // 不读数组块 proto@16(BOOTSTRAP_RULES §1.5 布局悬崖)。无递归环:目标非数组。
        // 仅自有键:否则 Object.prototype.toString 会经原型链冒出来,零参 arr.toString()
        // 的编译器路径依赖 miss → _valueToStr(数组 join 形);误命中则变成 [object Array]。
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_object_get_done");
        // arguments 对象: [[Prototype]] 是 Object.prototype (非 Array.prototype)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_object_get_args_proto");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_subscript_key_int"); // RET = idx >= 0 / -1
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_object_get_notfound"); // 真 hole
        // constructor miss 是 _array_species_check 的 default 快路前提;一旦落到
        // Array.prototype.constructor,concat/splice 会进 _agen_* 回退(实参寄存器被
        // compileExpression 冲掉)。方法名仍走下方自有键。
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.V0, "_str_constructor_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_get_notfound");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_object_get_notfound"); // 槽未物化
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has"); // own-only
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_notfound");
        // (fall through continues below — keep existing proto own-get)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.jmp("_object_get_done");
        vm.label("_object_get_args_proto");
        vm.lea(VReg.V0, "_nsobj_object_proto");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_object_get_args_proto_ok");
        vm.call("_object_proto_ensure");
        vm.lea(VReg.V0, "_nsobj_object_proto");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.label("_object_get_args_proto_ok");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.label("_object_get_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // 数组 Symbol 自有键:侧表(_closure_prop_get);miss → Array.prototype(覆盖的 @@iterator 等)。
        vm.label("_object_get_array_sym");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_get");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_object_get_done");
        // Honour per-array [[Prototype]] overrides for Symbol lookup as well.
        // %Array.prototype% is a real array whose override is Object.prototype;
        // falling straight back to the global array-prototype slot recurses on
        // the same receiver for a missing Symbol key.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_get_instance_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_array_sym_default");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.cmpImm(VReg.V1, 0x7FFA); // explicit null prototype
        vm.jeq("_object_get_notfound");
        vm.jmp("_object_get_array_sym_proto");
        vm.label("_object_get_array_sym_default");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_object_get_notfound");
        vm.label("_object_get_array_sym_proto");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.jmp("_object_get_done");

        // 冷分支:接收者是装箱字符串(S0 保持**装箱**形态——本分支在 _object_get_tag_ok
        // 的脱壳之前分流)。按 ES 的 String exotic object 语义路由:
        //   1) 规范数值索引键 → 单字符;越界 → undefined(_str_index_char 的 str[i] 语义)。
        //      键判定复用 _subscript_key_int(内部即 _canonical_array_index):"0"/"1"/"42"
        //      是索引,"01"/"1.0"/" 1"/"-0"/"1e2"/"" 不是 → -1 → 落具名路径 → undefined。
        //      非字符串键(裸整数/float64 位)由 _subscript_key_int 的 _syscall_arg 支路归一。
        //   2) "length" → _js_length(其 0x7FFC 支路走 _str_length)→ 装箱为 JS number
        //      (float64 位模式,同 _object_get_dv_num)。
        //   3) 其余具名键 → String.prototype (GetV = ToObject then [[Get]])。
        //      "length" 仍是 String exotic own (not proto). Symbol keys (@@iterator)
        //      used to miss here because only 0x7FFC "length" was accepted —
        //      ""[Symbol.iterator] stayed undefined. Slot empty → notfound
        //      (compiler emitStringProtoObject fills it before @@iterator GET).
        //      Recurse is safe: proto is 0x7FFD, not 0x7FFC.
        vm.label("_object_get_string");
        vm.mov(VReg.A0, VReg.S1); // key
        vm.call("_subscript_key_int"); // RET = 规范索引(>=0) / -1
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S2, 0);
        vm.jlt("_object_get_str_named");
        vm.mov(VReg.A0, VReg.S0); // 装箱字符串接收者
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_str_index_char"); // 越界 → 装箱 undefined
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        vm.label("_object_get_str_named");
        // own "length" first; Symbol / other named → proto walk (x64 V1 tag, not V0).
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_object_get_str_proto");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, this.vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_get_str_proto");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_length"); // RET = 裸整数长度
        vm.mov(VReg.V0, VReg.RET);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0); // 裸 int → canonical float64 位模式
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        vm.label("_object_get_str_proto");
        vm.lea(VReg.V0, "_nsobj_string_proto");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_object_get_notfound");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
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

        // Closure magic first (full word). 0xc105 low byte is TYPE_SET=5.
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_object_get_fn_raw");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_object_get_fn_raw");

        // Map(type=4)/Set(type=5) 不是属性对象（链表/哈希布局，非 [count@8,props_ptr@32]）。
        // 按对象头遍历会把 bucket_count/size 当 count/props_ptr 读 → 解引用垃圾崩。
        // 它们的方法(get/has/add...)由编译器 tag 分派，不经此路径；任意字符串属性一律 undefined。
        vm.loadByte(VReg.V1, VReg.S0, 0); // type 字节
        // 裸指针数组(高16位=0,type@0==TYPE_ARRAY==1):同装箱数组(0x7FFE)
        // 走 _object_get_array(索引键→元素,具名键→侧表;miss→undefined)。
        // 数组头无 props_ptr@32,按对象头扫会把 length@8 当 count、邻槽当
        // props_ptr 野读 → SIGSEGV(accessor getter 里未装箱 this.foo)。
        // 不解开 array proto fallthrough:_object_get_array 侧表 miss 后仍直接返回。
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jeq("_object_get_array");
        vm.cmpImm(VReg.V1, 4);
        vm.jeq("_object_get_map"); // Map:原型 fallthrough(Get(map,"set") 等)
        vm.cmpImm(VReg.V1, 5);
        vm.jeq("_object_get_set"); // Set:原型 fallthrough + @@iterator 桩
        // TypedArray(0x40-0x7f)/ArrayBuffer(12) 同理不是属性对象:[length@8,数据@16+],
        // 按对象头遍历会把 length 当 count、props_ptr@32 越块读邻居 → 垃圾解引用崩
        // (2026-07-10 实证:f32.buffer 落此路径,bump 邻居为 0 时静默 undefined,
        // GC 复用后邻居非零 → 确定性崩,任务 #19)。
        // ArrayBuffer 须应答 byteLength/maxByteLength/resizable(槽)以及原型上的
        // resize/slice:否则 `fixed.byteLength` 在 makeResizableArrayBuffer 里是
        // undefined → `new ArrayBuffer(0,{max:0})` → 空视图,includes/at 整簇假失败。
        vm.cmpImm(VReg.V1, 12);
        vm.jeq("_object_get_arraybuffer");
        // Date(7):16B 块无 props 槽;具名属性走闭包侧表(与数组/函数同登记)。
        // 先查侧表,miss 再走原型链(Date.prototype.get 等)——defineProperty 以 Date 作
        // Attributes、defineProperties 以 Date 作 Properties 依赖此。
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jeq("_object_get_date_side");
        vm.cmpImm(VReg.V1, TYPE_PROMISE);
        vm.jeq("_object_get_promise_side");
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
        vm.jle("_object_get_ta_side");
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
        vm.load(VReg.V0, VReg.S0, 16); // __proto__
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(notFoundLabel);
        // [proto boxed guard] compileDynamicNew / compilePlainFunctionNew 存 proto
        // 可能为装箱值(0x7FFD/0x7FFE)或裸指针。高16非0 → 已是装箱对象,直接用作 A0;
        // 否则读取类型字节判断是 Object(TYPE_OBJECT=2)还是 Array(TYPE_ARRAY=1),
        // 打对应 tag——此前一律标 0x7FFD,Array 原型按对象布局解引用 props_ptr@32 崩。
        vm.shrImm(VReg.V2, VReg.V0, 48);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_object_get_proto_boxed");
        // 裸指针:根据类型字节打 tag
        vm.loadByte(VReg.V2, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 1); // TYPE_ARRAY
        vm.jne("_object_get_proto_raw_obj");
        // Array proto → 装箱为 0x7FFE
        vm.movImm64(VReg.A0, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V0);
        vm.jmp("_object_get_proto_call");
        vm.label("_object_get_proto_raw_obj");
        // Builtin ctor (Promise/Map/…) is a 0xc105 closure. Box as 0x7FFF so
        // recursive Get hits _closure_prop_get (C.resolve / C.all / C.bind).
        // 0x7FFD-boxing made loadByte type=0x05 → TYPE_SET miss.
        vm.load(VReg.V2, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 0xc105);
        vm.jeq("_object_get_proto_raw_fn");
        vm.cmpImm(VReg.V2, 0xa51c);
        vm.jeq("_object_get_proto_raw_fn");
        // 其余裸指针 → 装箱为 0x7FFD (Object/classinfo/Symbol/Map/Set 等)
        vm.movImm64(VReg.A0, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V0);
        vm.jmp("_object_get_proto_call");
        vm.label("_object_get_proto_raw_fn");
        vm.movImm64(VReg.A0, 0x7fff000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V0);
        vm.jmp("_object_get_proto_call");
        vm.label("_object_get_proto_boxed");
        vm.mov(VReg.A0, VReg.V0);
        vm.label("_object_get_proto_call");
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
        vm.jne("_object_get_symbol_proto");
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

        vm.label("_object_get_symbol_proto");
        vm.call("_ensure_symbol_proto");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0); // getter receiver is the primitive Symbol
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // Set(type=5):非属性堆。先查已物化的 Set.prototype;再对 @@iterator /
        // "Symbol.iterator" 返回惰性方法桩(供 Object.prototype.toString 区测
        // symbol-tag-set-builtin 的迭代器 tag 链;不实现真 next 遍历)。
        vm.label("_object_get_set");
        vm.load(VReg.V0, VReg.S0, 48); // weakness:WeakSet 不可迭代
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_object_get_notfound");
        // 原型单例已物化 → Get(proto, key);命中非 undefined 则用之
        vm.lea(VReg.V0, "_nsobj_set_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_object_get_set_iter");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB); // undefined → 继续 iterator 桩
        vm.jeq("_object_get_set_iter");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_set_iter");
        // 键是 "Symbol.iterator" 字符串或 well-known @@iterator?
        vm.lea(VReg.A0, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_get_set_iter_hit");
        vm.lea(VReg.A0, "_symwk_iterator");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.cmp(VReg.RET, VReg.S1);
        vm.jne("_object_get_notfound");
        vm.label("_object_get_set_iter_hit");
        vm.call("_set_iterator_method_get"); // RET = 装箱方法闭包
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // Map:与 Set 同形(无 props 槽)。Get(map,"set") 必须落到 Map.prototype.set,
        // 否则 construct-fill 永远看不见用户覆盖。WeakMap(weakness@48) 仍 miss。
        vm.label("_object_get_map");
        vm.load(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_object_get_notfound");
        vm.lea(VReg.V0, "_nsobj_map_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_object_get_notfound");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // [W7b] Date:侧表自有属性 + Date.prototype 继承(无 __proto__ 槽)
        vm.label("_object_get_date_side");
        // 重装箱 Date 供 _closure_prop_get(接受裸/箱)
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_get");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_object_get_date_hit");
        // 继承:读 _nsobj_date_proto(由 members.js 物化;未物化则 0 → undefined)
        vm.lea(VReg.V0, "_nsobj_date_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq(notFoundLabel);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_date_hit");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // Promise:与 Date 同形侧表(defineProperty(p,"then",…) 必须 own 可见)。
        // 旧路径 TYPE_PROMISE → notfound,覆盖的 then 永远 miss → 品牌 then2,
        // 永不 done 的 iterable 上 Promise.all/race 死循环(invoke-then-*-close)。
        vm.label("_object_get_promise_side");
        // Presence and value are separate questions: an own property whose
        // value is `undefined` still shadows Promise.prototype.  Testing the
        // `_closure_prop_get` result against the undefined sentinel treated
        // that valid hit as a miss (`p.then = undefined` then read the
        // inherited intrinsic), which broke finally/Invoke semantics.
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_promise_own_miss");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_promise_own_miss");
        // class extends Promise: _promise_super_init keeps subclass proto at +48.
        // Walk that before Promise.prototype so instance.constructor === SubPromise.
        vm.load(VReg.V2, VReg.S0, 48);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_ogps_defproto");
        vm.mov(VReg.RET, VReg.V2);
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_ogps_havep");
        vm.call("_box_obj_r");
        vm.label("_ogps_havep");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_ogps_defproto");
        // proto slot is 0 until JS evaluates Promise; hang then/catch/finally
        // so typeof p.then === "function" (harness throwsAsync).
        vm.call("_ensure_promise_proto");
        vm.mov(VReg.A0, VReg.RET);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq(notFoundLabel);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        // TypedArray 具名属性:侧表(ta.constructor=…)+原型链;整数键走元素读。
        // 此前一律 notfound → SpeciesConstructor 看不到覆盖的 constructor。
        vm.label("_object_get_ta_side");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_subscript_key_int");
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_object_get_ta_idx");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_get");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_object_get_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_getprototypeof");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_get_notfound");
        // x64 aliases V0 with RET.  Keep the prototype tag check in V1 so
        // the boxed prototype value remains intact for the delegated get.
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_object_get_notfound");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_object_get_notfound");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_ta_idx");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_typed_array_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // [W7b] Date:侧表自有属性 + Date.prototype 继承(无 __proto__ 槽)
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

        // ArrayBuffer:内建访问器读头槽;其余键走 ArrayBuffer.prototype(resize/slice)。
        // 访问器必须在此直接算值——原型上挂的是 TYPE_GETTER 块,found 路径只回块指针
        // 不调 getter,依赖原型会把 byteLength 读成对象。
        vm.label("_object_get_arraybuffer");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("byteLength"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_ab_bl");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("maxByteLength"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_ab_mbl");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("resizable"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_ab_rz");
        vm.movImm(VReg.A0, 0x70); // ArrayBuffer 伪类型 → _get_ctor_proto
        vm.call("_get_ctor_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_get_notfound");
        // V0 == RET on x64; use V1 for the undefined guard to preserve the
        // boxed ArrayBuffer.prototype passed to `_object_get` below.
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_object_get_notfound");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_ab_bl");
        vm.load(VReg.V0, VReg.S0, 8);
        vm.jmp("_object_get_ab_num");
        vm.label("_object_get_ab_mbl");
        vm.load(VReg.V0, VReg.S0, 32);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_object_get_ab_num");
        vm.load(VReg.V0, VReg.S0, 8); // 不可 resize → 规范返回 byteLength
        vm.label("_object_get_ab_num");
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_ab_rz");
        vm.load(VReg.V0, VReg.S0, 32);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_object_get_ab_rz_t");
        vm.movImm64(VReg.RET, 0x7ff9000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_ab_rz_t");
        vm.movImm64(VReg.RET, 0x7ff9000000000001n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // ===== Proxy get 陷阱(冷分支;S0=裸 proxy 指针, S1=装箱键)=====
        vm.label("_object_get_proxy");
        vm.load(VReg.S3, VReg.S0, 16);  // handler(装箱)
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_object_get_proxy_revoked");
        vm.shrImm(VReg.V1, VReg.S3, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_object_get_proxy_revoked");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_object_get_proxy_revoked");
        vm.load(VReg.S2, VReg.S0, 8);   // target(装箱)
        // PrivateFieldGet does not use [[Get]]. Mangled keys are "#Class#name".
        vm.shrImm(VReg.V2, VReg.S1, 48);
        vm.cmpImm(VReg.V2, 0x7FFC);
        vm.jne("_ogp_not_priv");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogp_not_priv");
        vm.loadByte(VReg.V2, VReg.RET, 0);
        vm.cmpImm(VReg.V2, 35); // '#'
        vm.jeq("_object_get_proxy_priv");
        vm.label("_ogp_not_priv");
        // GetMethod(handler, "get"): present-not-callable → TypeError
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, this.vm.asm.addString("get"));
        vm.call("_proxy_trap_fn");
        vm.mov(VReg.S4, VReg.RET);
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_object_get_proxy_fwd");
        // GetIterator 读侧用字符串键 "Symbol.iterator";规范键是 @@iterator。
        // 陷阱必须收到 well-known symbol,否则 `""+prop` 拼到字符串而非 TypeError
        // (set/this-backed-by-resizable-buffer 的 throwingProxy)。
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogp_key_as_is");
        vm.lea(VReg.A0, "_symwk_iterator");
        vm.lea(VReg.A1, this.vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_ogp_key_as_is");
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
        // PrivateFieldGet on a Proxy: own [[PrivateElements]] (side table @24),
        // then target's proto chain (accessors live on prototype). Never target
        // own — wrapping an instance must not see its private fields.
        vm.label("_object_get_proxy_priv");
        vm.load(VReg.S4, VReg.S0, 24);
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_ogp_priv_proto");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogp_priv_proto");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_ogp_priv_proto");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_js_unbox");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogp_priv_miss");
        vm.loadByte(VReg.V2, VReg.RET, 0);
        vm.cmpImm(VReg.V2, 2);
        vm.jeq("_ogp_priv_ldproto");
        vm.cmpImm(VReg.V2, 3);
        vm.jne("_ogp_priv_miss");
        vm.label("_ogp_priv_ldproto");
        vm.load(VReg.A0, VReg.RET, 16);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_ogp_priv_miss");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_ogp_priv_miss");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_object_get_proxy_revoked");
        vm.lea(VReg.A0, vm.asm.addString("proxy revoked"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    // _proxy_new(A0=target 装箱, A1=handler 装箱) -> 装箱 0x7FFD proxy
    // 块布局:type@0=TYPE_PROXY, target@8, handler@16, 其余清零(避免 GC 保守扫垃圾字)。
    // ProxyCreate: Type(target)/Type(handler) 须为 Object,否则 TypeError。
    // 撤销的 Proxy 仍是 Object(test262 create-*-is-revoked-* 期望成功)。
    generateProxyNew() {
        const vm = this.vm;
        const requireObj = (srcReg, okLabel) => {
            // x64: tag 用 V2,不碰 V0≡RET。srcReg 是 S1/S2(callee-saved)。
            vm.shrImm(VReg.V2, srcReg, 48);
            vm.cmpImm(VReg.V2, 0x7FFD);
            vm.jeq(okLabel);
            vm.cmpImm(VReg.V2, 0x7FFE);
            vm.jeq(okLabel);
            vm.cmpImm(VReg.V2, 0x7FFF);
            vm.jeq(okLabel);
            vm.cmpImm(VReg.V2, 0);
            vm.jne("_pn_bad");
            vm.cmpImm(srcReg, 0);
            vm.jeq("_pn_bad");
            vm.mov(VReg.A0, srcReg);
            vm.call("_is_symbol");
            vm.cmpImm(VReg.RET, 0);
            vm.jne("_pn_bad");
            vm.mov(VReg.A0, srcReg);
            vm.call("_is_bigint");
            vm.cmpImm(VReg.RET, 0);
            vm.jne("_pn_bad");
            vm.lea(VReg.V2, "_heap_base");
            vm.load(VReg.V2, VReg.V2, 0);
            vm.cmp(srcReg, VReg.V2);
            vm.jb("_pn_bad");
            vm.lea(VReg.V2, "_heap_ptr");
            vm.load(VReg.V2, VReg.V2, 0);
            vm.cmp(srcReg, VReg.V2);
            vm.jae("_pn_bad");
            vm.load(VReg.V2, srcReg, 0);
            vm.cmpImm(VReg.V2, 0xc105);
            vm.jeq(okLabel);
            vm.cmpImm(VReg.V2, 0xa51c);
            vm.jeq(okLabel);
            vm.andImm(VReg.V2, VReg.V2, 0xff);
            vm.cmpImm(VReg.V2, 1);
            vm.jlt("_pn_bad");
            vm.cmpImm(VReg.V2, 14);
            vm.jgt("_pn_bad");
        };
        vm.label("_proxy_new");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A0); // target
        vm.mov(VReg.S2, VReg.A1); // handler
        requireObj(VReg.S1, "_pn_tgt_ok");
        vm.label("_pn_tgt_ok");
        requireObj(VReg.S2, "_pn_hnd_ok");
        vm.label("_pn_hnd_ok");
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
        vm.mov(VReg.RET, VReg.S0);
        vm.call("_box_obj_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_pn_bad");
        vm.lea(VReg.A0, vm.asm.addString("Cannot create proxy with a non-object as target or handler"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        // Proxy() 不带 new(值路径):TypeError。new Proxy 走 compileNewExpression 快路。
        vm.label("_proxy_ctor_call");
        vm.prologue(16, [VReg.S0]);
        vm.lea(VReg.A0, vm.asm.addString("Constructor Proxy requires 'new'"));
        vm.call("_js_box_string");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0], 16);
    }

    // Proxy.revocable(target, handler) → {proxy, revoke}。
    // revoke 把 handler@16 写成 0;之后 IsArray / [[Get]] 抛 TypeError。
    generateProxyRevocable() {
        const vm = this.vm;
        const UNDEF = 0x7ffb000000000000n;
        vm.label("_proxy_revoke");
        vm.label("_proxy_revoke_tramp");
        vm.load(VReg.A0, VReg.S0, 24); // boxed proxy
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.A0, 16, VReg.V1);
        vm.movImm64(VReg.RET, UNDEF);
        vm.ret();

        vm.label("_proxy_revocable");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_proxy_new");
        vm.mov(VReg.S0, VReg.RET); // boxed proxy
        vm.movImm(VReg.A0, 32);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S1, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.S1, 8, VReg.V1);
        vm.lea(VReg.V1, "_proxy_revoke");
        vm.store(VReg.S1, 16, VReg.V1);
        vm.store(VReg.S1, 24, VReg.S0);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_box_function");
        vm.mov(VReg.S1, VReg.RET); // boxed revoke
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("proxy"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("revoke"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_set");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // _proxy_trap_fn(A0=proxy_raw, A1=trap_name_cstr) -> RET = 陷阱函数(tag 0x7FFF)或 0。
    // GetMethod(handler, name): undefined/null/miss → 0(调用方转发 target);
    // 有值但不可调用 → TypeError;函数 → 返回。apply/construct/ownKeys/get/set/has/delete/isExtensible 共用。
    generateProxyTrapFn() {
        const vm = this.vm;
        vm.label("_proxy_trap_fn");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.load(VReg.V0, VReg.A0, 16); // handler
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ptf_revoked");
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_ptf_revoked");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_ptf_revoked");
        vm.load(VReg.S1, VReg.A0, 16); // handler(装箱; getter receiver)
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.A1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1); // 装箱字符串键
        vm.call("_object_get"); // RET = handler[name] or raw accessor marker
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter"); // GetMethod performs ordinary [[Get]]
        // x64 V0≡RET: stash then tag-extract from S0.
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V2, VReg.S0, 48);
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jeq("_ptf_ok");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_ptf_none");
        vm.cmpImm(VReg.V2, 0x7FFB); // undefined
        vm.jeq("_ptf_none");
        vm.cmpImm(VReg.V2, 0x7FFA); // null
        vm.jeq("_ptf_none");
        // A callable handler may be represented as a tagged function or as a
        // raw closure pointer.  The former fast check misses the latter on
        // x64; defer to the canonical IsCallable helper before rejecting it.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ptf_ok");
        vm.lea(VReg.A0, vm.asm.addString("trap is not a function"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_ptf_ok");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16); // RET = 陷阱函数
        vm.label("_ptf_none");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_ptf_revoked");
        vm.lea(VReg.A0, vm.asm.addString("proxy revoked"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    // Private elements live on the proxy itself, not [[ProxyTarget]].
    // Slot @24: boxed TYPE_OBJECT side table (0 until first PrivateFieldAdd).
    // _is_priv_key(A0=key) -> 1 if string starts with '#'.
    // _proxy_priv_own(A0=proxy_raw) -> boxed table or 0.
    // _proxy_priv_ensure(A0=proxy_raw) -> boxed table (creates).
    generateProxyPrivHelpers() {
        const vm = this.vm;
        vm.label("_is_priv_key");
        vm.prologue(0, []);
        vm.shrImm(VReg.V2, VReg.A0, 48);
        vm.cmpImm(VReg.V2, 0x7FFC);
        vm.jeq("_ipk_str");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_ipk_no");
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_ipk_no");
        vm.jmp("_ipk_byte");
        vm.label("_ipk_str");
        vm.call("_getStrContent");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ipk_no");
        vm.mov(VReg.A0, VReg.RET);
        vm.label("_ipk_byte");
        vm.loadByte(VReg.V2, VReg.A0, 0);
        vm.cmpImm(VReg.V2, 35); // '#'
        vm.jne("_ipk_no");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([], 0);
        vm.label("_ipk_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);

        vm.label("_proxy_priv_own");
        vm.prologue(0, []);
        vm.load(VReg.RET, VReg.A0, 24);
        vm.epilogue([], 0);

        vm.label("_proxy_priv_ensure");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.load(VReg.RET, VReg.S0, 24);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ppe_have");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.store(VReg.S0, 24, VReg.RET);
        vm.label("_ppe_have");
        vm.epilogue([VReg.S0], 16);
    }

    // _proxy_isPrototypeOf(A0=boxed proto, A1=boxed x) -> js_true/js_false
    // Called from _is_prototype_of when x is a Proxy. Invokes the
    // handler.getPrototypeOf trap and compares the result against proto.
    generateProxyIsPrototypeOf() {
        const vm = this.vm;
        vm.label("_proxy_isPrototypeOf");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // boxed proto
        vm.mov(VReg.S1, VReg.A1); // boxed x (proxy)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S2, VReg.S1, VReg.V1); // S2 = proxy raw
        // Try getPrototypeOf trap
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("getPrototypeOf"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pipo_no_trap");
        vm.mov(VReg.A3, VReg.RET);            // A3 = trap fn
        vm.load(VReg.A0, VReg.S2, 8);         // A0 = proxy target
        vm.lea(VReg.A1, "_js_undefined");
        vm.load(VReg.A1, VReg.A1, 0);         // A1 = undefined thisArg
        vm.mov(VReg.A2, VReg.A1);              // A2 = undefined arg
        vm.call("_aref_invoke_cb");            // RET = trap result
        // Check trap result: must be an object (or array)
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pipo_check");
        vm.cmpImm(VReg.V1, 0x7FFE);        // array
        vm.jeq("_pipo_check");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pipo_false");
        vm.label("_pipo_check");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1); // V0 = trap result raw
        vm.mov(VReg.A1, VReg.V0);              // A1 = trap result raw
        vm.load(VReg.A0, VReg.SP, 48);         // A0 = proto raw (from epilogue slot)
        vm.jmp("_pipo_loop_start");
        vm.label("_pipo_no_trap");
        // No trap: use target's proto chain
        vm.load(VReg.A0, VReg.S2, 8);         // V0 = proxy target
        // Strip tag on target
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_pipo_false");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1); // V0 = target raw
        vm.mov(VReg.A1, VReg.V0);              // A1 = target raw
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V1); // A0 = proto raw
        vm.label("_pipo_loop_start");
        // A0 = proto raw, A1 = cur raw
        vm.cmp(VReg.A1, VReg.A0);
        vm.jeq("_pipo_true");
        vm.label("_pipo_loop");
        // Guard: only traverse proto on objects (type byte 2) and classinfo (3).
        // Arrays (1), Dates (7), Maps (4) etc. have different layout — skip.
        vm.loadByte(VReg.V2, VReg.A1, 0);
        vm.andImm(VReg.V2, VReg.V2, 0xff);
        vm.cmpImm(VReg.V2, 2);                 // TYPE_OBJECT
        vm.jeq("_pipo_ld_proto");
        vm.cmpImm(VReg.V2, 3);                 // classinfo
        vm.jne("_pipo_false");
        vm.label("_pipo_ld_proto");
        vm.load(VReg.A1, VReg.A1, 16);         // cur = cur.__proto__
        vm.cmpImm(VReg.A1, 0);
        vm.jeq("_pipo_false");
        vm.cmp(VReg.A1, VReg.A0);
        vm.jeq("_pipo_true");
        vm.jmp("_pipo_loop");
        vm.label("_pipo_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
        vm.label("_pipo_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 48);
    }

    // [Stage A] Object.prototype 方法引用的包装 helper(经 _aref_generic 蹦床调用,
    // 接收者在 A0):_aref_obj_hasOwn 归一 _object_has 的裸 0/1 为规范 JS bool;
    // _aref_obj_valueOf 即恒等(Object.prototype.valueOf(this) === this)。
    generateArefObjHelpers() {
        const vm = this.vm;
        vm.label("_aref_obj_hasOwn");
        vm.prologue(16, []);
        // ES 19.1.3.1: ToObject(this). null/undefined this → TypeError.
        // hasOwn 自身(同 Object.hasOwn 半平台)仅自有判;null/undefined 抛。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_aref_oho_throw");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_aref_oho_throw");
        vm.call("_object_has"); // A0=obj, A1=key 透传;RET=裸 0/1
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_aref_oho_false");
        vm.movImm64(VReg.RET, 0x7ff9000000000001n);
        vm.epilogue([], 16);
        vm.label("_aref_oho_false");
        vm.movImm64(VReg.RET, 0x7ff9000000000000n);
        vm.epilogue([], 16);
        vm.label("_aref_oho_throw");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V0);
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V0);
        vm.call("_throw_type_error"); // 不返回
        vm.movImm64(VReg.RET, 0x7ff9000000000000n); // 理论不达:返回 false 作哨兵
        vm.epilogue([], 16);

        vm.label("_aref_obj_valueOf");
        // ES 19.1.3.7: ToObject(this) 后返回;null/undefined → TypeError;
        // bool/number/string 原语 → Boolean/Number/String wrapper。
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA); // null
        vm.jeq("_aref_vof_nullish");
        vm.cmpImm(VReg.V1, 0x7FFB); // undefined
        vm.jeq("_aref_vof_nullish");
        vm.cmpImm(VReg.V1, 0x7FF9); // boolean
        vm.jeq("_aref_vof_bool");
        vm.cmpImm(VReg.V1, 0x7FFC); // string
        vm.jeq("_aref_vof_str");
        vm.cmpImm(VReg.V1, 0x7FF8); // tagged int
        vm.jeq("_aref_vof_num");
        vm.cmpImm(VReg.V1, 0x7FFD); // object
        vm.jeq("_aref_vof_id");
        vm.cmpImm(VReg.V1, 0x7FFE); // array
        vm.jeq("_aref_vof_id");
        vm.cmpImm(VReg.V1, 0x7FFF); // function
        vm.jeq("_aref_vof_id");
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_aref_vof_hip0");
        // 其余高16(浮点/NaN)→ Number wrapper
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_aref_vof_num");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jgt("_aref_vof_num");
        vm.jmp("_aref_vof_id");
        vm.label("_aref_vof_hip0");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_aref_vof_num"); // +0.0
        vm.jmp("_aref_vof_id"); // 裸堆指针
        vm.label("_aref_vof_bool");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_boolean_new");
        vm.epilogue([VReg.S0], 16);
        vm.label("_aref_vof_num");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_new");
        vm.epilogue([VReg.S0], 16);
        vm.label("_aref_vof_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_string_new");
        vm.epilogue([VReg.S0], 16);
        vm.label("_aref_vof_id");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 16);
        vm.label("_aref_vof_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0], 16);
    }

    // [Stage A2] _aref_static_tramp: 内置静态非构造器方法引用的蹦床。
    // 闭包布局: {CLOSURE_MAGIC@0, _aref_static_tramp@8, helper@16}。
    // 调用点按普通闭包分派进来: S0=合成块、A0-A4=实参、_call_argc=实参个数。
    // 从闭包@16 取真实 helper、尾调之(无接收者移位——静态方法 this 无关)。
    // compileDynamicNew 检查 fnptr==_aref_static_tramp → 抛 TypeError
    // "value is not a constructor"。
    generateArefStaticTramp() {
        const vm = this.vm;
        vm.label("_aref_static_tramp");
        vm.prologue(0, []); // save FP/LR
        vm.load(VReg.V6, VReg.S0, 16);  // V6 = real helper label (S0=raw closure)
        vm.callIndirect(VReg.V6);       // helper(A0-A5, _call_argc); RET = result
        vm.epilogue([], 0);
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
            vm.call("_array_push_own");
            vm.store(VReg.SP, 40, VReg.RET);
        }
        vm.label("_pat_arr_done");
        vm.label("_pat_trap_lookup");
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
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jeq("_pat_fwd_proxy");
        vm.mov(VReg.V1, VReg.V0);
        vm.movImm(VReg.S0, 0);
        vm.jmp("_pat_fwd_call");
        vm.label("_pat_fwd_closure");
        vm.mov(VReg.S0, VReg.V0);
        vm.load(VReg.V1, VReg.V0, 8);
        vm.label("_pat_fwd_call");
        // x64 V1≡A3: load A3 would smash the entry. V6 is free of A0-A5.
        vm.mov(VReg.V6, VReg.V1);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.load(VReg.A3, VReg.SP, 24);
        vm.load(VReg.A4, VReg.SP, 32);
        vm.mov(VReg.A5, VReg.S3);
        vm.lea(VReg.V5, "_call_argc"); // argc 透传(截断后的 S4)
        vm.store(VReg.V5, 0, VReg.S4);
        vm.callIndirect(VReg.V6);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_pat_fwd_proxy");
        // target 是可调用 Proxy:重入 apply 蹦床(嵌套 / apply:undefined 转发)。
        vm.mov(VReg.S1, VReg.V0);
        vm.load(VReg.S2, VReg.S1, 8);
        vm.load(VReg.S5, VReg.S1, 16);
        vm.jmp("_pat_trap_lookup");
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
        vm.mov(VReg.S1, VReg.S3);      // 构造器序言:S1=classinfo(捕获盒@48)
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
        vm.movImm(VReg.A2, 0);
        vm.call("_fn_construct_call");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label("_pcc_fwd_throw");
        vm.call("_throw_not_a_function");
    }

    // _fn_construct_call(A0=fn 值(任意形态), A1=实参 boxed 数组) -> RET = 实例/覆盖对象。
    // 闭包:ES5 约定 A0..A4=实参、A5=this(镜像 compilePlainFunctionNew)。
    // classinfo(type@0==3):类约定 A0=this、A1..A5=实参(镜像 compileDynamicNew /
    // _pcc_forward)。species 调用户 class ctor 走这里;旧实现按闭包读 +8 当
    // fnptr → SIGSEGV(slice/speciesctor-resize)。
    generateFnConstructCall() {
        const vm = this.vm;
        vm.label("_fn_construct_call");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A0);      // fn 值(原形态)
        vm.store(VReg.SP, 0, VReg.A1); // argsArr
        vm.store(VReg.SP, 48, VReg.A2); // explicit NewTarget (0 → use fn)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S3, VReg.S1, VReg.V1); // S3 = 裸闭包/classinfo
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_fcc_class_bad");
        // Bound Function [[Construct]] (ES 10.3.4.2): prepend BoundArguments,
        // ignore thisArg, and if newTarget is the bound fn (A2==0 / SameValue)
        // set newTarget to BoundTargetFunction. _bound_tramp is [[Call]] only —
        // calling it as a ctor overwrote A5 with thisArg so `new (F.bind({},3,4))()`
        // wrote the bound object and returned an empty instance.
        vm.load(VReg.V0, VReg.S3, 0);
        vm.cmpImm(VReg.V0, 0xc105);
        vm.jne("_fcc_not_bound");
        vm.load(VReg.V0, VReg.S3, 8);
        vm.lea(VReg.V5, "_bound_tramp"); // V5=R10, not an A-reg alias
        vm.cmp(VReg.V0, VReg.V5);
        vm.jne("_fcc_not_bound");
        vm.load(VReg.S2, VReg.S3, 16); // S2 = target (boxed)
        vm.load(VReg.S4, VReg.S3, 32); // S4 = nBound
        vm.cmpImm(VReg.S4, 0);
        vm.jge("_fcc_bn_gez");
        vm.movImm(VReg.S4, 0);
        vm.label("_fcc_bn_gez");
        vm.cmpImm(VReg.S4, 4);
        vm.jle("_fcc_bn_ok");
        vm.movImm(VReg.S4, 4);
        vm.label("_fcc_bn_ok");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");      // RET = incoming len (S* survive)
        vm.mov(VReg.S5, VReg.RET);     // S5 = inLen
        vm.add(VReg.S0, VReg.S4, VReg.S5);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_new_with_size"); // RET = naked concat
        vm.mov(VReg.S0, VReg.RET);     // S0 = concat (naked ok for _array_*)
        for (let i = 0; i < 4; i++) {
            const skip = "_fcc_bn_bskip_" + i;
            vm.cmpImm(VReg.S4, i);
            vm.jle(skip);
            vm.load(VReg.A2, VReg.S3, 40 + i * 8);
            vm.mov(VReg.A0, VReg.S0);
            vm.movImm(VReg.A1, i);
            vm.call("_array_set");
            vm.label(skip);
        }
        for (let i = 0; i < 5; i++) {
            const skip = "_fcc_bn_iskip_" + i;
            vm.cmpImm(VReg.S5, i);
            vm.jle(skip);
            vm.load(VReg.A0, VReg.SP, 0);
            vm.movImm(VReg.A1, i);
            vm.call("_array_get");
            vm.mov(VReg.A2, VReg.RET);
            vm.mov(VReg.A0, VReg.S0);
            vm.addImm(VReg.A1, VReg.S4, i);
            vm.call("_array_set");
            vm.label(skip);
        }
        vm.load(VReg.V6, VReg.SP, 48); // explicit NewTarget
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_fcc_bn_nt_target");
        vm.cmp(VReg.V6, VReg.S1);
        vm.jeq("_fcc_bn_nt_target");
        vm.mov(VReg.A2, VReg.V6);
        vm.jmp("_fcc_bn_call");
        vm.label("_fcc_bn_nt_target");
        vm.mov(VReg.A2, VReg.S2);      // newTarget = target
        vm.label("_fcc_bn_call");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_fn_construct_call");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_fcc_not_bound");
        vm.call("_object_new");
        vm.mov(VReg.S4, VReg.RET);     // S4 = 新实例(裸)
        vm.loadByte(VReg.V0, VReg.S3, 0);
        vm.cmpImm(VReg.V0, 3);         // TYPE_FUNCTION / classinfo
        vm.jeq("_fcc_class");
        vm.load(VReg.S5, VReg.S3, 8);  // S5 = 真函数指针(V1=x64 RCX 与 A3 别名,禁跨装参)

        // 内建基本类型包装构造器 (String, Number, Boolean)
        vm.lea(VReg.V1, "_builtin_string");
        vm.cmp(VReg.S5, VReg.V1);
        vm.jeq("_fcc_builtin_string");
        vm.lea(VReg.V1, "_builtin_number");
        vm.cmp(VReg.S5, VReg.V1);
        vm.jeq("_fcc_builtin_number");
        vm.lea(VReg.V1, "_builtin_boolean");
        vm.cmp(VReg.S5, VReg.V1);
        vm.jeq("_fcc_builtin_boolean");
        // OrdinaryCreateFromConstructor(newTarget, "%Object.prototype%"):
        // proto = Get(newTarget, "prototype"), not Get(F, "prototype").
        // SuperCall Construct(fn, args, GetNewTarget()) for `class C extends fn`
        // / `class C extends fn.bind()` must use C.prototype. A2==0 → newTarget=F
        // (plain `new F()` / Bound [[Construct]] rewrite to target).
        vm.load(VReg.A0, VReg.SP, 48);
        vm.cmpImm(VReg.A0, 0);
        vm.jne("_fcc_proto_src");
        vm.mov(VReg.A0, VReg.S1);
        vm.label("_fcc_proto_src");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V5, VReg.A0, VReg.V1); // V5 = unboxed ctor (not V0: x64 V0≡RET)
        vm.cmpImm(VReg.V5, 0);
        vm.jeq("_fcc_noproto");
        vm.loadByte(VReg.V1, VReg.V5, 0);
        vm.cmpImm(VReg.V1, 3);         // classinfo
        vm.jeq("_fcc_proto_ci");
        vm.lea(VReg.A1, "_str_pcc_prototype");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_closure_prop_get");  // RET = ctor.prototype 或 undefined
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_fcc_noproto");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.S4, 16, VReg.V0);
        vm.jmp("_fcc_noproto");
        vm.label("_fcc_proto_ci");
        vm.load(VReg.V1, VReg.V5, 32); // props_ptr
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_fcc_noproto");
        vm.load(VReg.V0, VReg.V1, 24); // prototype raw
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
        vm.mov(VReg.A5, VReg.S4);      // this = 新实例
        // Box 0x7FFD so ctor `this` SameValue-matches the Construct result.
        // Raw A5 vs boxed RET was thisVal!==result (Array.from.call(C)).
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A5, VReg.A5, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A5, VReg.A5, VReg.V1);
        vm.lea(VReg.V5, "_call_argc");
        vm.store(VReg.V5, 0, VReg.S2);
        vm.load(VReg.V6, VReg.SP, 48);
        vm.cmpImm(VReg.V6, 0);
        vm.jne("_fcc_nt_fn");
        vm.mov(VReg.V6, VReg.S1);
        vm.label("_fcc_nt_fn");
        vm.lea(VReg.V5, "_call_new_target");
        vm.store(VReg.V5, 0, VReg.V6);
        vm.mov(VReg.S0, VReg.S3);      // S0 = 闭包块(捕获环境约定)
        vm.callIndirect(VReg.S5);
        vm.jmp("_fcc_after_call");
        vm.label("_fcc_class");
        vm.load(VReg.V1, VReg.S3, 32); // props_ptr
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_fcc_class_bad");
        vm.load(VReg.V0, VReg.V1, 24); // prototype
        vm.store(VReg.S4, 16, VReg.V0);
        vm.load(VReg.S5, VReg.V1, 8);  // ctor 地址
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_fcc_class_bad");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        for (let i = 0; i < 5; i++) {
            const undefL = `_fcc_c_undef_${i}`;
            const nextL = `_fcc_c_next_${i}`;
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
        vm.lea(VReg.V5, "_call_argc");
        vm.store(VReg.V5, 0, VReg.S2);
        vm.load(VReg.V6, VReg.SP, 48);
        vm.cmpImm(VReg.V6, 0);
        vm.jne("_fcc_nt_cls");
        vm.mov(VReg.V6, VReg.S1);
        vm.label("_fcc_nt_cls");
        vm.lea(VReg.V5, "_call_new_target");
        vm.store(VReg.V5, 0, VReg.V6);
        vm.mov(VReg.S1, VReg.S3);      // 构造器序言:S1=classinfo(捕获盒@48)
        vm.callIndirect(VReg.S5);
        vm.label("_fcc_after_call");
        // Construct:Type(result) is Object → 用返回值,否则用 this。
        // 0x7FFD/7FFE/7FFF 是装箱对象;裸堆指针(高16=0,含 TypedArray)也是 Object。
        // 旧逻辑丢掉裸 TA → species `return otherTA` 变成空 this → ValidateTypedArray 炸。
        vm.mov(VReg.V1, VReg.RET);
        vm.shrImm(VReg.V1, VReg.V1, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_fcc_end");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_fcc_end");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_fcc_end");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_fcc_use_this");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fcc_use_this");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jlt("_fcc_use_this");
        vm.loadByte(VReg.V1, VReg.RET, 0);
        vm.cmpImm(VReg.V1, 61); // TYPE_SYMBOL — Type(Symbol) 不是 Object
        vm.jeq("_fcc_use_this");
        vm.jmp("_fcc_end");
        vm.label("_fcc_use_this");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.label("_fcc_end");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_fcc_builtin_string");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fcc_bstr_empty");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_string_new");
        vm.jmp("_fcc_end");
        vm.label("_fcc_bstr_empty");
        vm.lea(VReg.A0, vm.asm.addString(""));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_string_new");
        vm.jmp("_fcc_end");

        vm.label("_fcc_builtin_number");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fcc_bnum_zero");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_number_coerce");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_number_new");
        vm.jmp("_fcc_end");
        vm.label("_fcc_bnum_zero");
        vm.movImm(VReg.A0, 0);
        vm.call("_number_new");
        vm.jmp("_fcc_end");

        vm.label("_fcc_builtin_boolean");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fcc_bbool_false");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_boolean_new");
        vm.jmp("_fcc_end");
        vm.label("_fcc_bbool_false");
        vm.movImm(VReg.A0, 0);
        vm.call("_boolean_new");
        vm.jmp("_fcc_end");

        vm.label("_fcc_class_bad");
        vm.lea(VReg.A0, this.vm.asm.addString("value is not a constructor"));
        vm.call("_js_box_string");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // _object_defineProperty_proxy(A0=proxy_boxed, A1=key, A2=descObj) -> boxed Boolean。
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
        // [不变式] 陷阱返 truthy 时校验(t372)。falsy 是 [[DefineOwnProperty]] false；
        // 是否抛由下面的 DefinePropertyOrThrow 包装器决定。
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odpp_false");
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
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_odpp_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_odpp_fwd");
        // 无陷阱:完整转发 descriptor；嵌套 Proxy 继续走其 [[DefineOwnProperty]]。
        vm.load(VReg.A0, VReg.S0, 8); // target
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_odpp_fwd_plain");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jne("_odpp_fwd_plain");
        vm.mov(VReg.A1, VReg.S1); // key
        vm.mov(VReg.A2, VReg.S2); // descriptor
        vm.call("_object_defineProperty_proxy");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_odpp_fwd_plain");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_define_property_dyn");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // DefinePropertyOrThrow wrapper used by Object.defineProperty,
        // SetIntegrityLevel and Annex-B defining accessors. Reflect.defineProperty
        // intentionally calls the raw Boolean helper above.
        vm.label("_object_defineProperty_proxy_or_throw");
        vm.prologue(0, []);
        vm.call("_object_defineProperty_proxy");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odpp_ot_throw");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
        vm.label("_odpp_ot_throw");
        vm.lea(VReg.A0, vm.asm.addString("Proxy defineProperty trap returned false"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
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

    // _proxy_ownkeys_validate(A0=proxy_raw, A1=trapResult) — [[OwnPropertyKeys]]
    // invariants including symbol keys (gOPN filters strings only AFTER this).
    generateProxyOwnKeysValidate() {
        const vm = this.vm;
        // CreateListFromArrayLike(trapResult, «String, Symbol»).  The ownKeys
        // trap may return any object, not only an actual Array; length and each
        // indexed value are ordinary observable Gets in that order.
        vm.label("_proxy_ownkeys_to_list");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_dp_require_object");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_agen_tolength");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_pok_list_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pok_list_done");
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_valueToStr");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S4, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S4, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_pok_list_push");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pok_list_bad");
        vm.label("_pok_list_push");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push_own");
        vm.mov(VReg.S1, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pok_list_loop");
        vm.label("_pok_list_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.S1, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
        vm.label("_pok_list_bad");
        vm.lea(VReg.A0, vm.asm.addString("ownKeys trap result contains an invalid key"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        vm.label("_pok_array_has");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_pok_ah_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pok_ah_miss");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pok_ah_hit");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pok_ah_loop");
        vm.label("_pok_ah_hit");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_pok_ah_miss");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        vm.label("_proxy_ownkeys_validate");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // proxy raw
        vm.mov(VReg.S1, VReg.A1); // trap result
        vm.shrImm(VReg.V2, VReg.S1, 48);
        vm.cmpImm(VReg.V2, 0x7FFE);
        vm.jeq("_pok_is_arr");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_pok_bad");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_pok_bad");
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 1);
        vm.jne("_pok_bad");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V1);
        vm.jmp("_pok_is_arr");
        vm.label("_pok_bad");
        vm.lea(VReg.A0, vm.asm.addString("proxy invariant violation"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_pok_is_arr");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_pok_dup_i");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pok_dup_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.addImm(VReg.S4, VReg.S3, 1);
        vm.label("_pok_dup_j");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_pok_dup_inext");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pok_throw");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_pok_dup_j");
        vm.label("_pok_dup_inext");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pok_dup_i");
        vm.label("_pok_dup_done");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_object_all_own_keys");
        vm.mov(VReg.S5, VReg.RET);
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_array_length");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_object_isExtensible");
        vm.lea(VReg.V1, "_js_false");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_pok_nonext");
        vm.movImm(VReg.V0, 1);
        vm.jmp("_pok_ext_st");
        vm.label("_pok_nonext");
        vm.movImm(VReg.V0, 0);
        vm.label("_pok_ext_st");
        vm.store(VReg.SP, 16, VReg.V0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_pok_nonext_exact");
        vm.movImm(VReg.S3, 0);
        vm.label("_pok_tk_i");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmp(VReg.S3, VReg.V0);
        vm.jge("_pok_tk_done");
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET);
        vm.load(VReg.A0, VReg.S0, 8);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jne("_pok_tk_next");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, this.vm.asm.addString("configurable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.lea(VReg.V1, "_js_false");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_pok_must");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_pok_tk_next");
        vm.label("_pok_must");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_pok_array_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pok_throw");
        vm.label("_pok_tk_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pok_tk_i");
        vm.label("_pok_tk_done");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_pok_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_pok_ex_i");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pok_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.RET);
        vm.call("_pok_array_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pok_throw");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pok_ex_i");
        // For a non-extensible target, after duplicate rejection the trap list
        // must be exactly targetKeys.  Compare cardinality and membership
        // directly; configurability is irrelevant in this branch.
        vm.label("_pok_nonext_exact");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmp(VReg.RET, VReg.V0);
        vm.jne("_pok_throw");
        vm.movImm(VReg.S3, 0);
        vm.label("_pok_nonext_exact_loop");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmp(VReg.S3, VReg.V0);
        vm.jge("_pok_ok");
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_pok_array_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pok_throw");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pok_nonext_exact_loop");
        vm.label("_pok_ok");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_pok_throw");
        vm.lea(VReg.A0, vm.asm.addString("proxy invariant violation"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
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
        // arm64 has RET === A0 (x0): loading the cached property value into RET
        // already overwrote the original receiver.  V4 still holds the guarded
        // ordinary object's raw pointer on every fast-path branch, so reconstruct
        // the boxed receiver from it instead of passing an accessor marker as this.
        vm.mov(VReg.A1, VReg.V4);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.RET);
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
        // [proto boxed guard] compileDynamicNew 存 proto 可能为装箱值(0x7FFD/0x7FFE),
        // 而非裸指针。若高16非0 → 已是装箱对象,落委托(避免把装箱值当指针解引用 SIGSEGV)。
        vm.shrImm(VReg.V3, VReg.V1, 48);
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_ogic_slow_delegate");
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

    // _re_flag_brand(A0=this) → 0=真正则 / 1=%RegExp.prototype% / 否则 TypeError。
    // 10 个标志 getter 共用,避免每访问器编译一遍 brand AST(冷编译 208→240ms 主因)。
    // 不可在 getter AST 写 Identifier RegExp(emitRegExpCtorObject 编译期重入)。
    generateReFlagBrand() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_re_flag_brand");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_rfb_bad");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_rfb_bad");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_rfb_obj");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_rfb_obj");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_rfb_bad");
        vm.label("_rfb_obj");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__isRegExp"));
        boxStr(VReg.A1);
        vm.call("_object_get");
        vm.movImm64(VReg.V1, 0x7ff9000000000001n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_rfb_re");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__reProto"));
        boxStr(VReg.A1);
        vm.call("_object_get");
        vm.movImm64(VReg.V1, 0x3ff0000000000000n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_rfb_proto");
        vm.jmp("_rfb_bad");
        vm.label("_rfb_re");
        vm.movImm(VReg.RET, 0);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0], 16);
        vm.label("_rfb_proto");
        vm.movImm(VReg.RET, 1);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0], 16);
        vm.label("_rfb_bad");
        vm.lea(VReg.A0, vm.asm.addString("Method RegExp.prototype.flags getter called on incompatible receiver"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0], 16);
    }

    // _re_flags_get(A0=this) → 装箱 flags 串。规范 get RegExp.prototype.flags:
    // this 非 Object → TypeError;否则按序 Get+ToBoolean 拼 d/g/i/m/s/u/v/y。
    // 无 [[RegExpMatcher]] 品牌(与单个 global 等访问器不同),故 get.call({}) 合法。
    generateReFlagsGet() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_re_flags_get");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_rfg_ok");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_rfg_ok");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_rfg_ok");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_rfg_bad");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_rfg_bad");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_rfg_bad");
        vm.label("_rfg_ok");
        vm.lea(VReg.S1, vm.asm.addString(""));
        boxStr(VReg.S1);
        const appendIf = (key, letter, tag) => {
            const skip = "_rfg_" + tag;
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString(key));
            boxStr(VReg.A1);
            vm.call("_object_has");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq(skip);
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString(key));
            boxStr(VReg.A1);
            vm.call("_object_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S0);
            vm.call("_maybe_getter");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_to_boolean");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq(skip);
            vm.mov(VReg.A0, VReg.S1);
            vm.lea(VReg.A1, vm.asm.addString(letter));
            boxStr(VReg.A1);
            vm.call("_strconcat");
            vm.mov(VReg.S1, VReg.RET);
            vm.label(skip);
        };
        appendIf("hasIndices", "d", "d");
        appendIf("global", "g", "g");
        appendIf("ignoreCase", "i", "i");
        appendIf("multiline", "m", "m");
        appendIf("dotAll", "s", "s");
        appendIf("unicode", "u", "u");
        appendIf("unicodeSets", "v", "v");
        appendIf("sticky", "y", "y");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_rfg_bad");
        vm.lea(VReg.A0, vm.asm.addString("Method RegExp.prototype.flags getter called on incompatible receiver"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _throw_reference_error(A0 = boxed message):与 _throw_type_error 同形,构造
    // ReferenceError {name:"ReferenceError",message,__asmjs_err,cause} 并 unwind。
    // 供 TDZ 读/写守卫(emitUninitializedBindingGuard/emitDestructureAssign)抛可捕获的
    // ReferenceError:守卫在**录制函数体**(P1 热槽晋升)内发射,须走单 call 形态
    // (emitThrowReferenceError 的 new ReferenceError 内联会分配局部槽/多次调用,
    // 录制重放错位 → 自举产物构造器字段丢失(vm.asm undefined)崩)。
    generateThrowReferenceError() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_throw_reference_error");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // S0 = boxed message
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET); // S2 = errObj(boxed)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("name")); boxStr(VReg.A1);
        vm.lea(VReg.A2, vm.asm.addString("ReferenceError")); boxStr(VReg.A2);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("message")); boxStr(VReg.A1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("__asmjs_err")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ff9000000000001n); // boxed true
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("cause")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ffb000000000000n); // undefined
        vm.call("_object_set");
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S2);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_throw_unwind"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16); // 理论不达
    }
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
        // 装箱数组(0x7FFE):数值索引清槽为 hole(0);具名键走侧表。
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_odel_array_boxed");
        // [I6] 函数值(0x7FFF)→ 闭包属性侧表删除(_closure_prop_del:name/length 落墓碑
        // 永久移除,其余键侧表常规删)。此前落 _odel_true 空转(delete 返 true 但属性被
        // 元数据回落复活,verifyProperty 的 isConfigurable 探针恒败)。
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_odel_fn");
        // ToObject(null/undefined) → TypeError。此前 0x7FFA/0x7FFB 落 _odel_true
        // 空转,`delete null[0]` 不抛(test262 member-computed-reference-null)。
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_odel_nullish");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_odel_nullish");
        vm.jmp("_odel_true");
        vm.label("_odel_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.call("_js_box_string");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error");
        vm.label("_odel_array_boxed");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.jmp("_odel_array");
        vm.label("_odel_tag_ok");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1); // 脱壳
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_odel_true");
        // [I6] 裸闭包指针(高16=0 堆闭包,全字 magic 0xc105/0xa51c;低字节 0x05 与
        // TYPE_SET 撞,字节分派不可辨——同 _prop_in :3196 全字判定)→ 函数值删除路径。
        // 普通对象 [S0]=type@0(8B)=2、数组=1,全字比较不与 magic 撞。
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_odel_fn_raw");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_odel_fn_raw");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY); // Proxy:冷分支调 handler.deleteProperty
        vm.jeq("_odel_proxy");
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_odel_do");
        vm.cmpImm(VReg.V1, 3); // TYPE_CLOSURE (classinfo; layout==TYPE_OBJECT, type@0=3)
        vm.jne("_odel_maybe_fn");
        vm.label("_odel_do");

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
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, this.vm.asm.addString("deleteProperty"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odel_proxy_fwd");
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

        // [I6] 函数值删除分派。_odel_fn:0x7FFF 装箱入口(脱壳 + NaN 载荷防御——
        // NaN 0x7FFF000000000001 与函数同高16,载荷 1 < ptrFloor → delete-miss true,
        // 同 _object_has :2979 形态)。_odel_fn_raw:裸闭包共享入口(S0=裸闭包指针,
        // S1=已归一装箱键),委托 _closure_prop_del(装箱布尔透传 delete 表达式值)。
        // [I6] 非对象类型字节出口:探测裸 TEXT 函数指针(类构造器/裸函数指针形态——
        // 高16=0、块头无闭包 magic、type 字节是指令字节恒 ≠ TYPE_OBJECT,此前一律落
        // _odel_true 使 delete 空转、name/length 被元数据复活)。函数元数据侧表按
        // code_ptr 登记全部编译期函数,命中 ⟹ 函数值 → 墓碑删除路。仅 type 字节非
        // TYPE_OBJECT/TYPE_PROXY 的裸堆指针入此(装箱数组/字符串/数值在上面 tag 分派
        // 已短路)。
        vm.label("_odel_maybe_fn");
        vm.cmpImm(VReg.V1, TYPE_TA_LO);
        vm.jlt("_odel_maybe_array");
        vm.cmpImm(VReg.V1, TYPE_TA_HI);
        vm.jle("_odel_ta");
        vm.label("_odel_maybe_array");
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY → 元素/侧表删除
        vm.jeq("_odel_array");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_func_meta_entry"); // RET=entry_ptr(0=未登记)
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odel_true");
        vm.jmp("_odel_fn_raw");

        // TypedArray integer-indexed elements are not deletable even though
        // their reflected configurable field is true.  Named properties use
        // ordinary side-table configurability.
        vm.label("_odel_ta");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index");
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_odel_ta_named");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.cmp(VReg.S2, VReg.RET);
        vm.jlt("_odel_false");
        vm.jmp("_odel_true");
        vm.label("_odel_ta_named");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_del");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // 数组 delete:规范数值索引 → 清槽为 hole(0),length 不变;非索引 → 侧表删。
        // S0=裸数组头,S1=已归一装箱键。
        vm.label("_odel_array");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index"); // RET = idx / -1
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_odel_array_named");
        vm.mov(VReg.S2, VReg.RET); // idx
        vm.load(VReg.V0, VReg.S0, 8); // length
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_odel_true"); // 越界 delete → true(属性本不存在)
        vm.cmpImm(VReg.S2, 0);
        vm.jlt("_odel_true");
        // freeze/seal make every existing array index non-configurable.  A
        // missing hole still deletes successfully, so distinguish side-table
        // and dense ownership before returning false.
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_FROZEN | EXT_ARRAY_SEALED);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_odel_arr_integrity_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_side_elem_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_odel_false");
        vm.load(VReg.V0, VReg.S0, 16); // capacity
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_odel_true");
        vm.load(VReg.V1, VReg.S0, 24);
        vm.shl(VReg.V0, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_odel_true");
        vm.jmp("_odel_false");
        vm.label("_odel_arr_integrity_ok");
        // [L1-A] 侧表条目(defineProperty 落过 attr/accessor 的索引键)委托 props 对象删除:
        // _object_delete(props,key) 的 _odel_hit 守卫尊重 per-index configurable ——
        // configurable:false → 返 false 且**不清稠密槽**(此前无条件清槽返 true,
        // verifyProperty 的 isConfigurable 探针两个方向恒败:可配置的删不净/不可配置的
        // 也"删成功")。无 ARR_HAS_SIDETABLE 位(从未 defineProperty)一条 loadByte 即过,
        // 行为与旧路径一致。
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_HAS_SIDETABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_odel_arr_dense");
        vm.mov(VReg.A0, VReg.S0); // 裸数组指针(侧表键;_closure_props_find 内部脱壳兼容)
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_odel_arr_dense");
        vm.mov(VReg.S3, VReg.RET); // props(装箱 0x7FFD)
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odel_arr_dense"); // 侧表无此索引 → 纯稠密删除(旧行为)
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_delete"); // 递归:props 是 TYPE_OBJECT,configurable 守卫生效
        vm.lea(VReg.V1, "_js_false");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_odel_false"); // 不可配置 → 拒删(槽保持,读侧仍经侧表)
        // 侧表条目已删 → 继续清稠密槽(数据条目的同步值,accessor 槽本为 hole 清之无害)
        vm.label("_odel_arr_dense");
        // [W7b] 稀疏大索引槽未物化:idx≥capacity 不写稠密槽(防 OOB 野写)
        vm.load(VReg.V0, VReg.S0, 16); // capacity
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_odel_true");
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V0, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.movImm(VReg.V1, 0); // hole
        vm.store(VReg.V0, 0, VReg.V1);
        // arguments [[ParameterMap]]: delete arguments[i] must unmap so a
        // later defineProperty does not write the formal (4-289-1 / 4-301-1).
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_odel_true");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S2); // idx
        vm.call("_args_param_map_unmap");
        vm.jmp("_odel_true");
        vm.label("_odel_array_named");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_del");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        vm.label("_odel_fn");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        // 0x7FFF|TEXT (linux PIE ~0x55) is below ptrFloor. The old jlt
        // _odel_true was NaN-payload defense (0x7FFF000000000001 → 1) but
        // also skipped class methods: delete returned true with no tombstone
        // and _func_meta_arity resurrected length (isConfigurable false).
        // Unboxed TEXT already reaches _odel_maybe_fn → _func_meta_entry.
        vm.jlt("_odel_fn_text");
        vm.label("_odel_fn_raw");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_del");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_odel_fn_text");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_func_meta_entry"); // RET=entry_ptr(0=unregistered / NaN payload)
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odel_true");
        vm.jmp("_odel_fn_raw");
    }

    // _private_brand_check(A0=obj, A1=改写后的私有键, A2=模式 0=读/1=写,
    //                       A3=current method receiver) -> RET 0
    // 私有成员是「品牌」而非普通属性:接收者 own 上找不到该私有名即 TypeError(不是 undefined);
    // 私有方法不可写;只 get 的私有访问器写、只 set 的私有访问器读同样 TypeError。
    // 实例私有字段/方法/访问器挂实例 own 槽;静态私有挂定义它的 classinfo own 槽。
    // PrivateBrandCheck 只看接收者 own(_object_has),不走原型链(_prop_in):
    // D extends C 时 D.f() 里 this.#g (this=D) 不得命中 C 上的静态 #g。
    generatePrivateBrandCheck() {
        const vm = this.vm;
        const boxMsg = (reg, s) => {
            vm.lea(reg, vm.asm.addString(s));
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };

        vm.label("_private_brand_check");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // obj
        vm.mov(VReg.S1, VReg.A1); // key
        vm.mov(VReg.S2, VReg.A2); // mode
        vm.mov(VReg.S3, VReg.A3); // current method receiver (0 when unavailable)

        // A class expression/declaration is evaluated afresh at runtime.  A
        // textual key such as "#C#m" therefore cannot by itself represent the
        // spec's per-evaluation private brand.  Instance methods carry their
        // current receiver in A3; comparing the candidate and current
        // instance prototypes is a compact identity check that fixes the
        // repeated-evaluation case while preserving the old own-key path for
        // callers that do not provide A3.  Static members are deliberately
        // left to the legacy path (their lexical owner is not the dynamic
        // `this` receiver and needs a separate token).
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_pbc_no_receiver");
        // Strip NaN-box object tags before pointer/type access and reject
        // values outside the managed heap; this keeps malformed/primitive
        // receivers on the normal TypeError path instead of dereferencing.
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V5, VReg.S0, VReg.V4); // candidate raw pointer
        vm.andMaskReg(VReg.V6, VReg.S3, VReg.V4); // current raw pointer
        vm.cmpImm(VReg.V5, 0);
        vm.jeq("_pbc_missing");
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_pbc_missing");
        vm.lea(VReg.V4, "_heap_base");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.cmp(VReg.V5, VReg.V4);
        vm.jlt("_pbc_missing");
        vm.cmp(VReg.V6, VReg.V4);
        vm.jlt("_pbc_missing");
        vm.lea(VReg.V4, "_heap_ptr");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.cmp(VReg.V5, VReg.V4);
        vm.jge("_pbc_missing");
        vm.cmp(VReg.V6, VReg.V4);
        vm.jge("_pbc_missing");
        vm.loadByte(VReg.V4, VReg.V5, 0);
        vm.loadByte(VReg.V7, VReg.V6, 0);
        // TYPE_FUNCTION (3) is the naked class-info representation.  For an
        // instance check both sides must be TYPE_OBJECT and share the same
        // prototype pointer at +16; class-info values compare by identity.
        vm.cmpImm(VReg.V4, 3);
        vm.jne("_pbc_brand_instance");
        vm.cmpImm(VReg.V7, 3);
        vm.jne("_pbc_missing");
        vm.cmp(VReg.V5, VReg.V6);
        vm.jne("_pbc_missing");
        vm.jmp("_pbc_no_receiver");
        vm.label("_pbc_brand_instance");
        vm.cmpImm(VReg.V4, 2);
        vm.jne("_pbc_no_receiver");
        vm.cmpImm(VReg.V7, 2);
        vm.jne("_pbc_missing");
        vm.load(VReg.V4, VReg.V5, 16);
        vm.load(VReg.V6, VReg.V6, 16);
        vm.cmp(VReg.V4, VReg.V6);
        vm.jne("_pbc_missing");
        vm.label("_pbc_no_receiver");

        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pbc_missing");

        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get"); // RET = 存储值(访问器返 TYPE_GETTER 标记,不触发调用)
        // x64 V0≡RET: save marker in S3 before any tag extract (same as _accessor_define).
        vm.mov(VReg.S3, VReg.RET);
        // 标记对象?(堆内裸指针且 type@+0 == TYPE_GETTER)
        vm.shrImm(VReg.V1, VReg.S3, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pbc_value");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_pbc_value");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jlt("_pbc_value");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jge("_pbc_value");
        vm.load(VReg.V1, VReg.S3, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER);
        vm.jne("_pbc_value");
        // 访问器:按模式取对应半边,缺者抛
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_pbc_acc_write");
        vm.load(VReg.V1, VReg.S3, 8);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pbc_no_getter");
        vm.jmp("_pbc_ok");
        vm.label("_pbc_acc_write");
        vm.load(VReg.V1, VReg.S3, 16);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pbc_no_setter");
        vm.jmp("_pbc_ok");

        // 数据值:写模式下若是函数(裸函数标签 0x7FFF 或堆闭包 magic)即私有方法 → 不可写
        vm.label("_pbc_value");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_pbc_ok");
        vm.shrImm(VReg.V1, VReg.S3, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pbc_method_write");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pbc_ok");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_pbc_ok");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jlt("_pbc_ok");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jge("_pbc_ok");
        vm.load(VReg.V1, VReg.S3, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_pbc_method_write");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_pbc_method_write");

        vm.label("_pbc_ok");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_pbc_missing");
        boxMsg(VReg.A0, "Cannot access private member on an object which does not have it");
        vm.call("_throw_type_error");
        vm.label("_pbc_no_getter");
        boxMsg(VReg.A0, "'#x' was defined without a getter");
        vm.call("_throw_type_error");
        vm.label("_pbc_no_setter");
        boxMsg(VReg.A0, "'#x' was defined without a setter");
        vm.call("_throw_type_error");
        vm.label("_pbc_method_write");
        boxMsg(VReg.A0, "Private method is not writable");
        vm.call("_throw_type_error");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _accessor_define(A0=obj, A1=key, A2=新标记对象裸指针) -> RET 0
    // 访问器定义走 [[DefineOwnProperty]] 的**部分描述符合并**语义:同键已有访问器时
    // 只覆盖本次给出的半边(getter 或 setter),另半边保留。编译期无法归组的运行时键
    // (`get [x||1]()` 与 `set [x||1]()` 是两个独立成员,键值只在运行期才知同不同)
    // 靠此合并;此前后者的 marker 直接 _object_define 覆盖前者 → 只剩一半访问器。
    // 自有键判定用 _object_has(非 `in`):否则 `get [k]()` 中 k==="__proto__" 会合进
    // Object.prototype 的 __proto__ 访问器 marker(全局投毒)。
    generateAccessorDefine() {
        const vm = this.vm;

        vm.label("_accessor_define");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // obj
        vm.mov(VReg.S1, VReg.A1); // key
        vm.mov(VReg.S2, VReg.A2); // 新 marker(裸指针)

        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_accdef_plain");

        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get"); // RET = 自有旧值(访问器不触发调用,原样返回 marker)
        // x64 V0≡RET: 先把旧 marker 挪到 S3,再用 V1 抽 tag / 比 heap。
        vm.mov(VReg.S3, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S3, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_accdef_plain");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_accdef_plain");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jlt("_accdef_plain");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jge("_accdef_plain");
        vm.load(VReg.V1, VReg.S3, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER);
        vm.jne("_accdef_plain");

        // 合并:新 marker 的非零槽写入旧 marker(旧 marker 留在属性槽里,身份不变)
        vm.mov(VReg.V2, VReg.S3); // 旧 marker
        vm.load(VReg.V0, VReg.S2, 8);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_accdef_merge_set");
        vm.store(VReg.V2, 8, VReg.V0);
        vm.label("_accdef_merge_set");
        vm.load(VReg.V0, VReg.S2, 16);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_accdef_done");
        vm.store(VReg.V2, 16, VReg.V0);
        vm.label("_accdef_done");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_accdef_plain");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_define");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
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
        // [array hole] 数组元素写路径已把 +0.0 规范为装箱 int0,槽 0=真 hole。
        // 对象属性 miss 哨兵仍为裸 0;此处 0 短路仍作「非 getter」通过(对象侧未改)。
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
        // [L1-Object] `_subscript_get` 对对象键先 `_js_unbox` 再把**裸指针**当 this
        // 传入;getter 内 `this === obj` / `instanceof` 因而恒假(Object.create 以
        // RegExp/JSON 等作 Properties 时访问器描述符读回依赖正确 this)。已装箱
        // (high16≠0)或空 this 原样;裸堆指针按 type 字节补 0x7FFD/0x7FFE。
        // V1 仍持函数指针,重装箱只用 V0。classinfo(type=3) 的语言级
        // 函数值表示就是裸指针，必须保持该表示：否则继承的 @@species
        // getter 返回的装箱 this 与标识符读回的裸 classinfo 不再 SameValue。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_maybe_getter_this_ok");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_maybe_getter_this_ok");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, 3); // classinfo: naked is its canonical language value
        vm.jeq("_maybe_getter_this_ok");
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jeq("_maybe_getter_box_arr");
        vm.movImm64(VReg.V0, 0x7ffd000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V0);
        vm.jmp("_maybe_getter_this_ok");
        vm.label("_maybe_getter_box_arr");
        vm.movImm64(VReg.V0, 0x7ffe000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V0);
        vm.label("_maybe_getter_this_ok");
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

        // _maybe_setter(A0=Get result, A1=this/receiver, A2=value)
        // TYPE_GETTER → Call setter@16 with this=receiver (Super SET / Set with
        // Receiver). Super PutValue is always-strict: missing setter → TypeError.
        // RET=1 handled. Else RET=0 so caller writes data on the receiver, not the
        // super base (avoids object-literal setter recurse: super.x = v ≠ this.x = v).
        vm.label("_maybe_setter");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // get result
        vm.mov(VReg.S1, VReg.A1); // this
        vm.mov(VReg.S2, VReg.A2); // value

        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_maybe_setter_miss");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_maybe_setter_miss");
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_maybe_setter_miss");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_maybe_setter_miss");
        vm.load(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_GETTER);
        vm.jne("_maybe_setter_miss");

        vm.load(VReg.V1, VReg.S0, 16); // setter
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_maybe_setter_noset");

        // Box raw this like _maybe_getter (high16=0 heap ptr), while keeping
        // classinfo naked because that is the canonical class value.
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_maybe_setter_this_ok");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_maybe_setter_this_ok");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, 3); // classinfo
        vm.jeq("_maybe_setter_this_ok");
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jeq("_maybe_setter_box_arr");
        vm.movImm64(VReg.V0, 0x7ffd000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V0);
        vm.jmp("_maybe_setter_this_ok");
        vm.label("_maybe_setter_box_arr");
        vm.movImm64(VReg.V0, 0x7ffe000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V0);
        vm.label("_maybe_setter_this_ok");

        // Closure vs raw TEXT. V1 = setter slot. Object-literal setters are
        // closures: S0 must be the closure (callee reads captures from S0).
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jlt("_maybe_setter_call");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jge("_maybe_setter_call");
        vm.load(VReg.V0, VReg.V1, 0);
        vm.cmpImm(VReg.V0, 0xc105); // CLOSURE_MAGIC
        vm.jeq("_maybe_setter_closure");
        vm.cmpImm(VReg.V0, 0xa51c); // ASYNC_CLOSURE_MAGIC
        vm.jne("_maybe_setter_call");
        vm.label("_maybe_setter_closure");
        vm.mov(VReg.S0, VReg.V1);
        vm.load(VReg.V1, VReg.S0, 8);

        vm.label("_maybe_setter_call");
        vm.mov(VReg.A0, VReg.S2); // value
        vm.mov(VReg.A5, VReg.S1); // this
        vm.setCallArgcImm(1, VReg.V0, VReg.V2);
        vm.callIndirect(VReg.V1);
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_maybe_setter_noset");
        vm.lea(VReg.A0, this.vm.asm.addString("Cannot set property"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        vm.label("_maybe_setter_miss");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

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

        // 严格赋值 PutValue:不可写/不可扩展新增 → TypeError(标志=2)。
        // define=1 / 普通赋值=0 / 严格赋值=2;仅 1 走 define 语义。
        vm.label("_object_set_strict");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm(VReg.V0, 2);
        vm.store(VReg.SP, 24, VReg.V0);
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
        // [I6] define 语义([SP+24]=1,_object_define 入口)分流 _closure_prop_define:
        // [[DefineOwnProperty]] 不受 name/length 不可写守卫阻(defineProperty 覆盖必须
        // 生效);赋值表达式路(标志=0)经 _closure_prop_set 带守卫。
        vm.label("_object_set_fnprops");
        vm.load(VReg.V0, VReg.SP, 24);
        vm.cmpImm(VReg.V0, 1);
        vm.jeq("_object_set_fnprops_def");
        vm.cmpImm(VReg.V0, 2);
        vm.jeq("_object_set_fnprops_strict");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_set");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_object_set_fnprops_strict");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_set_strict");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_object_set_fnprops_def");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_define");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // 数组具名/索引属性写分派(S0=arr[boxed 0x7FFE 或裸], S1=key, S2=value)。
        // 规范数值索引键(CanonicalNumericIndexString, 如 "1")→ 委托 _subscript_set 做数组
        // 元素写(含 _array_ensure_cap 增长、逻辑空档补 undefined、length 更新);_subscript_set
        // 内部 _js_unbox 容裸/装箱数组,_syscall_arg 对小整数下标走裸路径原样返回。非索引键
        // (a.foo)→ 属性侧表 _object_set_fnprops。_canonical_array_index 仅动 S0/S1(其 prologue
        // 保存并复原),不碰 S2,故 value 跨调用稳定。
        vm.label("_object_set_array");
        // [#L1-px] preventExtensions 后拒新增:byte1 & EXT_NONEXT
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1); // V0 = 裸数组
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_set_array_ok");
        // NONEXT:索引键 → 仅既有非 hole 可写;具名键 → 既有侧表键可写
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index");
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_set_array_px_named");
        // 索引:idx >= length 或 hole → 静默拒
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.load(VReg.V1, VReg.V0, 8); // length
        vm.cmp(VReg.RET, VReg.V1);
        vm.jge("_object_set_array_px_bail");
        vm.load(VReg.V2, VReg.V0, 24); // data_ptr
        vm.shl(VReg.V3, VReg.RET, 3);
        vm.add(VReg.V2, VReg.V2, VReg.V3);
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_set_array_px_bail"); // hole
        vm.jmp("_object_set_array_ok"); // 既有元素 → 允许改写
        vm.label("_object_set_array_px_named");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_set_array_px_bail"); // 无侧表 → 必无此键
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_set_array_px_bail");
        vm.jmp("_object_set_array_ok");
        vm.label("_object_set_array_px_bail");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_object_set_array_ok");
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

        // TEXT / non-heap function: 0x7FFF|TEXT may arrive unboxed (high16=0)
        // after a caller stripped the tag. x86 prologue bytes look like a
        // type (0x40..0x7f → TA; else object header) and the write hits
        // r-x TEXT → SIGSEGV. Route to the closure side table.
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_object_set_fnprops");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_object_set_fnprops");
        // Heap closure magic: same as tagged 0x7FFF (x64 _gc_remember
        // unbox can leave high16=0 on some aliases).
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_object_set_fnprops");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_object_set_fnprops");

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
        vm.jeq("_object_set_reject");
        // Date(7):具名属性走闭包侧表(defineProperties 以 Date 作 Properties)。
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jeq("_object_set_date_side");
        vm.cmpImm(VReg.V1, TYPE_PROMISE);
        vm.jeq("_object_set_date_side");
        vm.cmpImm(VReg.V1, TYPE_DATA_VIEW);
        vm.jeq("_object_set_ty_bail");
        // Proxy(type=8):冷分支调 handler.set 陷阱。
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jeq("_object_set_proxy");
        vm.cmpImm(VReg.V1, 0x40);
        vm.jlt("_object_set_ty_ok");
        vm.cmpImm(VReg.V1, 0x7f);
        vm.jgt("_object_set_ty_ok");
        vm.jmp("_object_set_ta_side");
        vm.label("_object_set_ty_bail");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        // [W7b] Date 具名写 → 侧表(+ preventExtensions 拒新增)
        vm.label("_object_set_date_side");
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.andImm(VReg.V1, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_set_date_do");
        // NONEXT:仅既有侧表键可写
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_set_date_px_bail");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_set_date_px_bail");
        vm.label("_object_set_date_do");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_set");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_object_set_date_px_bail");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        // TypedArray 具名写走侧表(ta.constructor=species 对象);整数键写元素。
        vm.label("_object_set_ta_side");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index");
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_object_set_ta_idx");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_set");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_object_set_ta_idx");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_typed_array_set");
        vm.mov(VReg.RET, VReg.S2);
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
        // [#73c] [访问器] 旧值为 TYPE_GETTER 标记对象 → setter@16 分派（为 0 则静默
        // 返回）。此检查必须在 writable 守卫之前:访问器属性无 writable 语义,而
        // defineProperty({get,set}) 建标记时 attrs 缺省全 false(writable=0),若先跑
        // writable 守卫会把 o.p=v 当"改写不可写数据属性"静默丢弃 → setter 永不触发
        // (#73c 根因)。非标记(普通数据属性)落 _object_set_wcheck 继续 writable 守卫;
        // define 语义(标志=1)直接覆写,既不分派访问器也不受 attrs 阻。
        vm.load(VReg.V1, VReg.SP, 24);
        vm.cmpImm(VReg.V1, 1);
        vm.jeq("_object_set_define_exist");
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
        // setter 槽为 0（只 get / set:undefined）→ 严格 TypeError / sloppy 静默
        vm.load(VReg.V0, VReg.V0, 16);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_reject");
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
        // User functions read positional registers directly; argc metadata
        // alone does not overwrite a stale property-key value in A1.
        vm.movImm64(VReg.A1, 0x7ffb000000000000n);
        vm.callIndirect(VReg.V0);
        vm.jmp(doneLabel);

        // define 覆写已有键:classinfo(type=3) 上 !configurable 槽任何覆写都抛。
        // `static ['prototype']()` / `static *['prototype']()` 是 0x7FFF 方法闭包,
        // 不是 TYPE_GETTER;旧路径只拦 accessor 覆写 → method/gen 静默改 prototype。
        // name/length 为 configurable,仍走 plain。普通对象不拦
        // (defineProperty 可给已有 !configurable 访问器补 get/set,15.2.3.6-4-21)。
        vm.label("_object_set_define_exist");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 3); // TYPE_CLOSURE / classinfo
        vm.jne("_object_set_plain");
        vm.load(VReg.V0, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_plain");
        vm.add(VReg.V0, VReg.V0, VReg.S4);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.andImm(VReg.V0, VReg.V0, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_reject_add");
        vm.jmp("_object_set_plain");

        // [#61 P2] per-property writable 位精确守卫(仅非访问器、非 define 的赋值到此)。
        // flags_ptr@40==0 → 全默认可写,一条 cmp 即过;materialize 后读 flags[S4]&bit0,
        // 清零 → 静默丢弃。S4=命中下标全程保活,仅用 V0 scratch。
        vm.label("_object_set_wcheck");
        // Frozen data properties are non-writable, but a frozen accessor may
        // still have a setter.  This guard belongs on the data path after the
        // TYPE_GETTER dispatch above; placing it at `foundLabel` suppressed
        // valid setter calls on Object.freeze({ set x(v) {} }).
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_FROZEN);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_object_set_reject");
        vm.load(VReg.V0, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_plain");
        vm.add(VReg.V0, VReg.V0, VReg.S4); // &flags[idx]
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.andImm(VReg.V0, VReg.V0, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_reject"); // 不可写:严格抛 / sloppy 静默
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
        // [proto boxed guard] proto 可能已是装箱值(compileDynamicNew 存 0x7FFD/0x7FFE),
        // 若高16非0则直接用作 A0,否则按裸指针读类型字节判定装箱 tag。
        // 此前裸指针一律装箱 0x7FFD:Array(type=1)头仅 32B(无 props_ptr@32),
        // 0x7FFD 进 _object_get 会被当 Object 遍历,在 [S0+32] 解引用野地址 → SIGSEGV。
        vm.shrImm(VReg.V2, VReg.V0, 48);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_object_set_proto_boxed");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_object_set_append"); // 低于 floor:非法指针 → 跳过原型查找
        vm.load(VReg.V2, VReg.V0, 0); // full word: 0xc105 low byte aliases TYPE_SET
        vm.cmpImm(VReg.V2, 0xc105);
        vm.jeq("_object_set_proto_fn");
        vm.cmpImm(VReg.V2, 0xa51c);
        vm.jeq("_object_set_proto_fn");
        vm.loadByte(VReg.V2, VReg.V0, 0); // 读类型字节
        vm.cmpImm(VReg.V2, 1); // TYPE_ARRAY
        vm.jeq("_object_set_proto_array");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.V0, VReg.V1);
        vm.jmp("_object_set_proto_call");
        vm.label("_object_set_proto_fn");
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A0, VReg.V0, VReg.V1);
        vm.jmp("_object_set_proto_call");
        vm.label("_object_set_proto_array");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.V0, VReg.V1);
        vm.jmp("_object_set_proto_call");
        vm.label("_object_set_proto_boxed");
        vm.mov(VReg.A0, VReg.V0);
        vm.label("_object_set_proto_call");
        vm.mov(VReg.A1, VReg.S1);
        vm.push(VReg.A0); // 保 proto boxed,供 data 属性 writable 判定
        vm.call("_object_get"); // 原型链查同名键
        vm.mov(VReg.V0, VReg.RET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_proto_miss"); // 链上无此键 → 正常追加 own
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0x7FFB); // undefined → 无继承属性
        vm.jeq("_object_set_proto_miss");
        vm.cmpImm(VReg.V1, 0x7FFA); // null
        vm.jeq("_object_set_proto_miss");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_object_set_proto_data"); // 链上 tagged 数据属性
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_object_set_proto_data");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_object_set_proto_data");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER);
        vm.jne("_object_set_proto_data");
        vm.pop(VReg.V1); // 丢弃 proto save;V0=访问器标记
        vm.jmp("_object_set_acc_dispatch"); // 链上访问器 → setter 分派（this=本对象）
        vm.label("_object_set_proto_data");
        vm.pop(VReg.A0); // proto boxed
        vm.mov(VReg.A1, VReg.S1); // key
        vm.call("_js_unbox");
        // 数组原型无 props_ptr@32:禁按对象头扫 writable(子类化 Array 写 length 等)。
        vm.loadByte(VReg.V1, VReg.RET, 0);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jne("_object_set_proto_data_obj");
        vm.mov(VReg.S4, VReg.RET); // proto raw array
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.V1, "_str_length_prop");
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V1, VReg.V2);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_set_proto_arr_len");
        // 其它具名键:侧表有则查 attr,否则视为可写继承数据 → own 遮蔽
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.S4, VReg.V1);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_set_append");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get_attr");
        vm.andImm(VReg.V0, VReg.RET, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_reject");
        vm.jmp("_object_set_append");
        vm.label("_object_set_proto_arr_len");
        vm.loadByte(VReg.V0, VReg.S4, 1);
        vm.andImm(VReg.V0, VReg.V0, 1); // ARR_LEN_NONWRITABLE
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_object_set_reject");
        vm.jmp("_object_set_append");
        vm.label("_object_set_proto_data_obj");
        vm.mov(VReg.V2, VReg.RET); // proto raw (restore after unbox)
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_set_append");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_object_set_append");
        vm.load(VReg.V1, VReg.V2, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_object_set_append");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_object_set_append");
        vm.load(VReg.V0, VReg.V2, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_proto_up");
        // x64: V2=RDX / V3=R8 / V4=R9 皆 caller-saved,且 V2≡A2。
        // _object_key_eq 会毁掉它们 → 第二轮把残留串指针当对象扫 props_ptr 崩。
        // 栈槽:[SP+32]=proto raw [SP+40]=count [SP+48]=idx(本帧 64B,16/24 已占用)。
        vm.store(VReg.SP, 32, VReg.V2); // proto raw
        vm.load(VReg.V3, VReg.V2, 8); // count
        vm.store(VReg.SP, 40, VReg.V3);
        vm.movImm(VReg.V4, 0); // idx
        vm.store(VReg.SP, 48, VReg.V4);
        vm.label("_object_set_proto_wloop");
        vm.load(VReg.V4, VReg.SP, 48);
        vm.load(VReg.V3, VReg.SP, 40);
        vm.cmp(VReg.V4, VReg.V3);
        vm.jge("_object_set_proto_up"); // 本层无此键 → 再走 __proto__
        vm.load(VReg.V2, VReg.SP, 32); // reload proto (call 后 V2 已死)
        vm.load(VReg.V0, VReg.V2, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_proto_up");
        vm.shl(VReg.V1, VReg.V4, 4);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_set_proto_wfound");
        vm.load(VReg.V4, VReg.SP, 48);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.store(VReg.SP, 48, VReg.V4);
        vm.jmp("_object_set_proto_wloop");
        vm.label("_object_set_proto_wfound");
        vm.load(VReg.A0, VReg.SP, 32); // proto raw
        vm.load(VReg.A1, VReg.SP, 48); // idx
        vm.call("_object_get_attr");
        vm.andImm(VReg.V0, VReg.RET, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_reject"); // 不可写继承属性:sloppy 静默 / strict 抛
        vm.jmp("_object_set_append"); // 可写继承属性 → 建 own 遮蔽
        // 2+ 级继承:immediate proto 无此 own 键时继续走链。
        // 旧码只扫 immediate → Object.create 孙对象赋值仍建 own
        // (15.2.3.6-4-415 Expected true but got false)。
        vm.label("_object_set_proto_up");
        vm.load(VReg.V0, VReg.SP, 32); // current proto raw
        vm.load(VReg.V0, VReg.V0, 16); // __proto__
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_append");
        vm.shrImm(VReg.V2, VReg.V0, 48);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_object_set_proto_up_boxed");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_object_set_append");
        vm.store(VReg.SP, 32, VReg.V0);
        vm.jmp("_object_set_proto_up_ready");
        vm.label("_object_set_proto_up_boxed");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 32, VReg.V0);
        vm.label("_object_set_proto_up_ready");
        vm.load(VReg.V2, VReg.SP, 32);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_set_append");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_object_set_append");
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 2); // TYPE_OBJECT:函数/Date 头无 props_ptr,停
        vm.jne("_object_set_append");
        vm.load(VReg.V0, VReg.V2, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_set_append");
        vm.load(VReg.V3, VReg.V2, 8); // count
        vm.store(VReg.SP, 40, VReg.V3);
        vm.movImm(VReg.V4, 0);
        vm.store(VReg.SP, 48, VReg.V4);
        vm.jmp("_object_set_proto_wloop");
        vm.label("_object_set_proto_miss");
        vm.pop(VReg.A0);

        vm.label("_object_set_append");
        // [#61 P1] non-extensible 对象拒绝新增属性(sloppy 静默 / 严格 TypeError)。
        // freeze/seal/preventExtensions 三者都置 EXT_NONEXT,故此一处覆盖全部。
        // 普通对象 byte1=0 一条 and 即过。
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_NONEXT);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_object_set_reject_add");
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
        // [I6] 追加须复位新槽 per-property attr(仅 flags 已 materialize 时):_object_delete
        // 的整体移位把被删槽旧 attr 残留在尾部(flags[count] 无人重置),追加入该下标的新
        // 属性会错误承袭——闭包侧表 name/length 墓碑槽(0x84)删除后重加即承袭墓碑位 →
        // 读恒 undefined、删后重赋永不生效(本增量删后重建语义的最后一环);普通对象同理
        // (defineProperty 加过非默认 attr 后删除某键、再追加新键会误承袭旧 attr 位)。
        // flags_ptr=0 时全属性默认 attr,一条 cmp 即过,普通对象追加路径近零税。
        vm.load(VReg.V1, VReg.S0, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_set_append_noflags");
        vm.add(VReg.V1, VReg.V1, VReg.S3);    // &flags[旧 count] = 新槽下标
        vm.movImm(VReg.V2, ATTR_DEFAULT);
        vm.storeByte(VReg.V1, 0, VReg.V2);
        vm.label("_object_set_append_noflags");
        // 更新 count
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.store(VReg.S0, 8, VReg.S3);

        // [L1-Object] Boolean/Number 包装的 `__boolean_value`/`__number_value` 是实现
        // 内部槽(对齐 ES [[BooleanData]]/[[NumberData]]),不得出现在 Object.keys——
        // 否则 Object.create({}, new Boolean) 把布尔原语当描述符 → TypeError。
        // 追加后强制 writable|configurable、非 enumerable(attr=5);flags 惰性 materialize。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne(doneLabel);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.lea(VReg.A1, vm.asm.addString("__boolean_value"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_set_intslot_ne");
        vm.mov(VReg.A0, VReg.S4);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_set_intslot_ne");
        vm.mov(VReg.A0, VReg.S4);
        vm.lea(VReg.A1, vm.asm.addString("__bigint_value"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne(doneLabel);
        vm.label("_object_set_intslot_ne");
        vm.mov(VReg.A0, VReg.S0);
        vm.subImm(VReg.A1, VReg.S3, 1); // 新槽下标 = count-1
        vm.movImm(VReg.A2, ATTR_WRITABLE | ATTR_CONFIGURABLE); // 5: 非 enumerable
        vm.call("_object_set_attr");

        // 已有属性拒写:仅严格赋值(2) TypeError;define(1)走 DefineOwnProperty,不经此。
        vm.label("_object_set_reject");
        vm.load(VReg.V0, VReg.SP, 24);
        vm.cmpImm(VReg.V0, 2);
        vm.jne(doneLabel);
        vm.jmp("_object_set_throw");
        // 新增拒:CreateDataPropertyOrThrow(define=1)与严格赋值(2)皆 TypeError。
        vm.label("_object_set_reject_add");
        vm.load(VReg.V0, VReg.SP, 24);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(doneLabel);
        vm.label("_object_set_throw");
        vm.lea(VReg.A0, this.vm.asm.addString("Cannot assign to read only property"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ===== Proxy set 陷阱(冷分支;S0=裸 proxy, S1=键, S2=值)=====
        vm.label("_object_set_proxy");
        vm.load(VReg.S3, VReg.S0, 8);   // target(装箱)
        vm.load(VReg.S4, VReg.S0, 16);  // handler(装箱)
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.S5, VReg.S0, VReg.V1); // receiver = 装箱 proxy
        // PrivateFieldAdd/Set does not use [[Set]].
        vm.shrImm(VReg.V2, VReg.S1, 48);
        vm.cmpImm(VReg.V2, 0x7FFC);
        vm.jne("_osp_not_priv");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_osp_not_priv");
        vm.loadByte(VReg.V2, VReg.RET, 0);
        vm.cmpImm(VReg.V2, 35); // '#'
        vm.jeq("_object_set_proxy_priv");
        vm.label("_osp_not_priv");
        // CreateDataPropertyOrThrow / [[DefineOwnProperty]] (flag=1), not [[Set]].
        vm.load(VReg.V2, VReg.SP, 24);
        vm.cmpImm(VReg.V2, 1);
        vm.jeq("_object_set_proxy_def");
        // GetMethod(handler, "set"): present-not-callable → TypeError
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, this.vm.asm.addString("set"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_set_proxy_fwd");
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
        // No set trap: target.[[Set]](key, value, receiver), not a direct
        // write to target.  OrdinarySetWithOwnDescriptor first validates the
        // target descriptor, then consults/defines the receiver's own
        // descriptor.  With a Proxy receiver those two operations must expose
        // getOwnPropertyDescriptor and defineProperty traps.
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.store(VReg.SP, 0, VReg.RET); // targetDesc
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_osp_fwd_inherited");
        // Accessor target descriptor: dispatch its setter with receiver as this.
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, this.vm.asm.addString("set"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_osp_fwd_target_data");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S5);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_maybe_setter");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_osp_fwd_done");
        vm.jmp("_object_set_reject");
        vm.label("_osp_fwd_target_data");
        // Non-writable target data property makes [[Set]] fail.
        vm.load(VReg.A0, VReg.SP, 0);
        vm.lea(VReg.A1, this.vm.asm.addString("writable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_set_reject");
        vm.jmp("_osp_fwd_receiver");

        vm.label("_osp_fwd_inherited");
        // A missing own descriptor may still resolve to an inherited setter.
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S5);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_maybe_setter");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_osp_fwd_done");

        vm.label("_osp_fwd_receiver");
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.store(VReg.SP, 8, VReg.RET); // receiverDesc
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_osp_fwd_receiver_new");
        // Existing receiver accessor or non-writable data descriptor rejects.
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, this.vm.asm.addString("set"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_set_reject");
        vm.load(VReg.A0, VReg.SP, 8);
        vm.lea(VReg.A1, this.vm.asm.addString("writable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_set_reject");
        // Existing writable data descriptor: DefineProperty(receiver,{value}).
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S3, VReg.RET);
        vm.jmp("_osp_fwd_desc_value");

        vm.label("_osp_fwd_receiver_new");
        // Missing receiver property: CreateDataProperty shape (all true).
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm64(VReg.S4, 0x7ff9000000000001n); // true
        for (const attrName of ["writable", "enumerable", "configurable"]) {
            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, this.vm.asm.addString(attrName));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.mov(VReg.A2, VReg.S4);
            vm.call("_object_set");
        }
        vm.label("_osp_fwd_desc_value");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_object_defineProperty_proxy");
        vm.label("_osp_fwd_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_object_set_proxy_priv");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_proxy_priv_ensure");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        // x64 V2≡A2: flag in V5 (R10), then A2=value.
        vm.load(VReg.V5, VReg.SP, 24);
        vm.mov(VReg.A2, VReg.S2);
        vm.cmpImm(VReg.V5, 1);
        vm.jeq("_osp_priv_def");
        vm.call("_object_set");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_osp_priv_def");
        vm.call("_object_define");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        // Public field init: build {value,w:true,e:true,c:true} and [[DefineOwnProperty]].
        vm.label("_object_set_proxy_def");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S3, VReg.RET); // S3 = boxed desc
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");
        vm.movImm64(VReg.S5, 0x7ff9000000000001n); // true
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("writable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("enumerable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, this.vm.asm.addString("configurable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_object_set");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_object_defineProperty_proxy");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // Reflect.set(target, key, value, receiver) -> boxed boolean.
    // Implements the OrdinarySetWithOwnDescriptor path needed when receiver
    // differs from target, including Proxy receiver MOP visibility.
    generateReflectSetReceiver() {
        const vm = this.vm;
        const TRUE = 0x7ff9000000000001n;
        const FALSE = 0x7ff9000000000002n;
        const UNDEF = 0x7ffb000000000000n;
        const key = (name) => {
            vm.lea(VReg.A1, vm.asm.addString(name));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
        };

        vm.label("_reflect_set_receiver");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // target
        vm.mov(VReg.S2, VReg.A2); // value
        vm.mov(VReg.S3, VReg.A3); // receiver
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET); // key

        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.store(VReg.SP, 0, VReg.RET); // targetDesc
        vm.movImm64(VReg.V1, UNDEF);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_rsr_target_missing");

        // Accessor descriptor: call [[Set]] with receiver as this.
        vm.mov(VReg.A0, VReg.RET);
        key("set");
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_rsr_target_data");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_maybe_setter");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_rsr_false");
        vm.jmp("_rsr_true");

        vm.label("_rsr_target_data");
        vm.load(VReg.A0, VReg.SP, 0);
        key("writable");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_rsr_false");
        vm.jmp("_rsr_receiver");

        vm.label("_rsr_target_missing");
        // No own descriptor: an inherited accessor still receives receiver.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_maybe_setter");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_rsr_true");

        vm.label("_rsr_receiver");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.store(VReg.SP, 8, VReg.RET); // receiverDesc
        vm.movImm64(VReg.V1, UNDEF);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_rsr_receiver_new");
        vm.mov(VReg.A0, VReg.RET);
        key("set");
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_rsr_false");
        vm.load(VReg.A0, VReg.SP, 8);
        key("writable");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_rsr_false");
        vm.movImm(VReg.S4, 0); // value-only descriptor
        vm.jmp("_rsr_make_desc");

        vm.label("_rsr_receiver_new");
        vm.movImm(VReg.S4, 1); // new property: W/E/C true
        vm.label("_rsr_make_desc");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S5, VReg.RET);
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_rsr_desc_value");
        vm.movImm64(VReg.S4, TRUE);
        for (const name of ["writable", "enumerable", "configurable"]) {
            vm.mov(VReg.A0, VReg.S5);
            key(name);
            vm.mov(VReg.A2, VReg.S4);
            vm.call("_object_set");
        }
        vm.label("_rsr_desc_value");
        vm.mov(VReg.A0, VReg.S5);
        key("value");
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");

        // Proxy receiver must expose [[DefineOwnProperty]]; ordinary receiver
        // can use the existing full dynamic descriptor path as well.
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S3, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jne("_rsr_define_ordinary");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_object_defineProperty_proxy");
        vm.jmp("_rsr_true");
        vm.label("_rsr_define_ordinary");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_define");
        vm.cmpImm(VReg.S4, 0); // boxed true for new, zero for existing
        vm.jeq("_rsr_true");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, ATTR_DEFAULT);
        vm.call("_object_set_prop_attr");

        vm.label("_rsr_true");
        vm.movImm64(VReg.RET, TRUE);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_rsr_false");
        vm.movImm64(VReg.RET, FALSE);
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
    //   - 高 16 位 == 0:小裸整数 → _intToStr;堆/数据段遗留裸串指针 asis;
    //     大整数下标(linux 2^32-2 ≥ ptrFloor=0x400000)亦 _intToStr,禁当指针
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
        // ToPropertyKey: Type(argument) is Symbol → return it.
        // Naked TYPE_SYMBOL (high16=0) used to fall into _jpk_low and
        // _intToStr (not TYPE_STRING at [ptr-16]). defineProperty(obj,
        // @@toPrimitive, getter) then stored a decimal-string key while
        // _call_toprimitive / GetIterator looked up the well-known pointer.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_jpk_asis");
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC); // 字符串键:直通
        vm.jeq("_jpk_asis");
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jlt("_jpk_low"); // 低于 tag 区:raw(高16=0) 或正 double
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jeq("_jpk_int32"); // 装箱 int32
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jgt("_jpk_double"); // > 0x7FFF:负 double(符号位)
        // [ToPropertyKey] 0x7FF9(bool)/0x7FFA(null)/0x7FFB(undefined)/0x7FFE(array)/
        // 0x7FFF(function):ES 7.1.19 → ToString。
        // 0x7FFD(object):先 ToPrimitive(hint string);若得 Symbol → 原样作键(禁 ToString);
        // 否则 ToString。旧实现对 object 直接 _valueToStr → Symbol.toPrimitive 返 Symbol 时
        // 抛 "Cannot convert a Symbol value to a string"(hasOwn/hasOwnProperty @@toPrimitive)。
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_jpk_object");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr"); // RET = 装箱堆字符串键
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_object");
        // Number 包装:ToString([[NumberData]]) ≡ Number.prototype.toString。
        // OTP 若找不到原型 toString,会落到 Object.prototype.toString / valueOf
        // 后再截断 → z[new Number(1.1)] 写成 z[1](S15.4_A1.1_T7)。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_get");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_jpk_object_otp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_jpk_object_otp");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_numberToString");
        vm.epilogue([VReg.S0], 0);
        vm.label("_jpk_object_otp");
        // ToPropertyKey = ToPrimitive(hint string) 后若 Symbol 则原样,否则 ToString。
        // 不可整段丢给 _valueToStr:OrdinaryToPrimitive 的 toString/valueOf 若返 Symbol,
        // _valueToStr 会再 ToString(Symbol) 抛(symbol_property_toString/valueOf)。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("string"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_call_toprimitive"); // RET = primitive | 原对象(无 trap)
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_jpk_asis"); // Symbol 键原样
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_jpk_otp");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_jpk_otp");
        // 已是原始值(非 Symbol):ToString
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0], 0);

        // OrdinaryToPrimitive PreferString:toString 优先,再 valueOf;结果若 Symbol → 原样
        vm.label("_jpk_otp");
        vm.push(VReg.S0); // 保对象(跨 user_tostr)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_user_tostr");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_jpk_otp_vo"); // toString 仍对象 → 试 valueOf
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_jpk_otp_vo");
        vm.mov(VReg.S0, VReg.RET);
        vm.pop(VReg.V0); // 丢弃保存的对象
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_jpk_asis");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_otp_vo");
        vm.pop(VReg.S0); // 恢复对象
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_user_valueof");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_jpk_otp_fail");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_jpk_otp_fail");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_jpk_otp_fail");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_jpk_asis");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_otp_fail");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert object to primitive value"));
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V0);
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V0);
        vm.call("_throw_type_error");

        vm.label("_jpk_asis");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);

        vm.label("_jpk_low");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_jpk_double"); // 指数非 0 的正 double
        // high16=0: small raw int / leftover unboxed string pointer / large
        // integer index. linux ptrFloor=0x400000 so o[4294967294]=x used to
        // treat 2^32-2 as a string pointer → _getStrContent SIGSEGV
        // (_js_prop_key / _object_set large-index). macos ptrFloor=2^32 so
        // 2^32-2 already _intToStr; 2^32 itself still hit asis.
        // Heap string leftover: [ptr-16] in [heap_base, heap_ptr) + TYPE_STRING.
        // Data-segment leftover: (ptrFloor, ptrFloor+64MB). Else ToString.
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_jpk_int");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_jpk_low_notheap");
        vm.subImm(VReg.V3, VReg.S0, 16);
        vm.cmp(VReg.V3, VReg.V1);
        vm.jlt("_jpk_low_notheap");
        vm.lea(VReg.V4, "_heap_ptr");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.cmp(VReg.V3, VReg.V4);
        vm.jge("_jpk_low_notheap");
        vm.load(VReg.V1, VReg.V3, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 6); // TYPE_STRING
        vm.jeq("_jpk_asis");
        vm.jmp("_jpk_int");
        vm.label("_jpk_low_notheap");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.sub(VReg.V3, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_jpk_int"); // exactly ptrFloor (macos 2^32 key)
        vm.movImm64(VReg.V1, 0x4000000n); // 64MB image window
        vm.cmp(VReg.V3, VReg.V1);
        vm.jlt("_jpk_asis");
        vm.label("_jpk_int");
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

    // _error_opt_has_cause(options, boxed key) -> 0/1
    // ES2022 InstallErrorCause 仅当 Type(options) 为 Object 才查 "cause";undefined/null/
    // 原始值须静默跳过。此前 Error 族构造直接 _object_has(options,"cause"),而派生类
    // **合成的默认构造器**转发 super(f0..f4) 会把 undefined 当 options 传进来 →
    // nullish 抛 "Cannot convert undefined or null to object" → `class E extends Error {}`
    // 的 new E() 全崩(subclass-builtins 族)。
    generateErrorOptHasCause() {
        const vm = this.vm;

        vm.label("_error_opt_has_cause");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);

        // 容器标签:裸堆指针(高16=0)/对象 0x7FFD/数组 0x7FFE/函数 0x7FFF;其余非 Object → 0
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_eohc_obj");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_eohc_obj");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_eohc_obj");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_eohc_obj");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_eohc_obj");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has"); // 函数标签的 NaN 载荷由 _object_has 的 ptrFloor 守卫挡掉
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _error_msg_norm(v) -> 装箱字符串
    // Error 构造的 message 语义:undefined → ""(规范是"不落 own message",读经原型链得
    // Error.prototype.message="";本实现按值语义落 "" 等价于读取结果),其余 ToString(v)
    // (`new Error(42).message === "42"`、对象走 toString、Symbol 抛 TypeError)。
    // 此前直接存原始参数值 → message 为 number/object,且派生类默认构造器转发的
    // undefined 变成 `e.message === undefined`。
    generateErrorMsgNorm() {
        const vm = this.vm;

        vm.label("_error_msg_norm");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFB); // undefined → ""
        vm.jeq("_emn_empty");
        vm.cmpImm(VReg.V1, 0x7FFC); // 已是装箱字符串 → 原样返回
        vm.jeq("_emn_same");

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr"); // 裸字符串指针
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_emn_same");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_emn_empty");
        vm.lea(VReg.RET, vm.asm.addString(""));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
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
        // ES hasOwnProperty: ToPropertyKey(V) 先于 ToObject(this)
        // (topropertykey_before_toobject)。Object.hasOwn 相反序由调用方
        // (_aref_obj_hasOwn / 编译期 Object.hasOwn)先对目标做 nullish 抛出。
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_object_has_key_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_object_has_key_ok");

        // [FIX] ToObject 语义:null/undefined target → TypeError(ES 20.1.2.2 step 1)
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA); // null
        vm.jeq("_object_has_nullish");
        vm.cmpImm(VReg.V1, 0x7FFB); // undefined
        vm.jeq("_object_has_nullish");
        vm.jmp("_object_has_tagchk");
        vm.label("_object_has_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        // 类型标签守卫:仅对象(0x7FFD)/数组(0x7FFE)/函数(0x7FFF)/裸堆指针(高16=0)才查属性;
        // 数字/布尔等非容器返回 0(否则脱壳成垃圾地址解引用崩,如 with(非对象) / 误用 hasOwn)。
        vm.label("_object_has_tagchk");
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_has_tagok");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_object_has_tagok");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_object_has_tagok");
        // [I5] 函数值(0x7FFF)亦属性容器(闭包属性侧表 + 规范 name/length):放过守卫,脱壳后
        // 按闭包全字 magic 分流(见下)。NaN(0x7FFF000000000001)与函数同高16、载荷 1,须以
        // ptrFloor 挡掉(否则把尾数位当地址解引用崩,与 _ogopd :6127 同形防御)。
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jne("_object_has_notcont");
        vm.movImm64(VReg.V2, 0x0000ffffffffffffn);
        vm.and(VReg.V3, VReg.S0, VReg.V2);   // 载荷
        vm.movImm64(VReg.V2, vm.ptrFloor);
        vm.cmp(VReg.V3, VReg.V2);
        vm.jlt("_object_has_notcont");       // NaN/数值尾数 → 非容器 → false
        vm.jmp("_object_has_tagok");
        vm.label("_object_has_notcont");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_object_has_tagok");

        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_has_false");

        // [I5] 闭包函数值先按全字 magic 判(0xc105/0xa51c;低字节 0x05 与 TYPE_SET 撞,字节
        // 分派不可辨——与 _subscript_get_closure :83 全字判定同源)。own 判定与 _ogopd_fn 的
        // own 性同构(侧表 + name/length 元数据回落),使 hasOwnProperty.call(fn,"name")/
        // symbol 键 `in`(经本 helper)与 gOPD 一致。此前函数恒 false → test262
        // propertyHelper verifyProperty 的 "should be an own property" 断言恒败。
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_object_has_fn");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_object_has_fn");
        // TEXT class methods: first insn byte is often 0x40-0x7f (REX / PUSH rbp
        // 0x55). The TA range check below must not run first — it treated
        // methods as TypedArray so hasOwn("length") stayed true after delete
        // (isConfigurable / class method-length-dflt). Check func_meta first.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_func_meta_entry");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_has_fn");
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
        // Proxy(TYPE_PROXY=8):布局 target@8/handler@16 与对象头不兼容,按对象头遍历
        // 解引用垃圾 → SIGSEGV。规范语义走 has trap 后才到自有属性,此处返回 false
        // (无自有属性;has trap 由 _proxy_has 专函处理,不经过本 helper)。
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jeq("_object_has_false");
        // Date(7):侧表自有属性(defineProperties Properties=Date)
        vm.cmpImm(VReg.V0, TYPE_DATE);
        vm.jeq("_object_has_date_side");
        vm.cmpImm(VReg.V0, TYPE_PROMISE);
        vm.jeq("_object_has_date_side");
        // TEXT already handled above (before TA). Remaining type-byte miss
        // is a plain object header (or junk that _object_has_obj will reject).
        vm.jmp("_object_has_obj");

        vm.label("_object_has_idx");
        // "length" 是数组/TypedArray/arguments 的自有数据属性(不可枚举)。
        // 此前非数字键直接 false → verifyProperty(arr,"length") / hasOwnProperty("length") 恒败。
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.V0, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_has_true");
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
        vm.jlt("_object_has_arr_side"); // 非数字 → 具名侧表(TYPE_ARRAY) / false(TA)
        vm.cmpImm(VReg.V0, 57); // '9'
        vm.jgt("_object_has_arr_side");
        vm.subImm(VReg.V0, VReg.V0, 48);
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.V3, VReg.V3, VReg.V1);
        vm.add(VReg.V3, VReg.V3, VReg.V0);
        vm.movImm(VReg.S3, 1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_object_has_arr_atoi");
        vm.label("_object_has_arr_done");
        vm.cmpImm(VReg.S3, 0); // 空串 → 侧表/false
        vm.jeq("_object_has_arr_side");
        // TypedArray length is live with respect to resizable buffers; do not
        // trust the cached header length for an out-of-bounds view.
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_TA_LO);
        vm.jlt("_object_has_len_ready");
        vm.cmpImm(VReg.V0, TYPE_TA_HI);
        vm.jgt("_object_has_len_ready");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_has_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_object_has_len_checked");
        vm.label("_object_has_len_ready");
        vm.load(VReg.S2, VReg.S0, 8); // length @ +8
        vm.label("_object_has_len_checked");
        vm.cmp(VReg.V3, VReg.S2);
        vm.jge("_object_has_arr_side"); // 越界索引仍可能在侧表(accessor define 未扩 length 的旧态)
        // TypedArray:界内 true。TYPE_ARRAY:槽!=0(真 hole);洞再查侧表
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jne("_object_has_true");
        // [W7b] 稀疏大 length:idx≥capacity 不读稠密槽(防 OOB),改查侧表
        vm.load(VReg.V0, VReg.S0, 16); // capacity
        vm.cmp(VReg.V3, VReg.V0);
        vm.jge("_object_has_arr_side");
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V0, VReg.V3, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_has_arr_side"); // hole → 侧表可能有 accessor/覆盖
        vm.jmp("_object_has_true");
        // TYPE_ARRAY 具名属性 / 索引侧表回落(defineProperty 写入的闭包 props)。
        // TypedArray 无此侧表 → false。
        vm.label("_object_has_arr_side");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jeq("_object_has_array_side");
        vm.cmpImm(VReg.V0, TYPE_TA_LO);
        vm.jlt("_object_has_false");
        vm.cmpImm(VReg.V0, TYPE_TA_HI);
        vm.jgt("_object_has_false");
        vm.jmp("_object_has_ta_side");
        vm.label("_object_has_array_side");
        vm.mov(VReg.A0, VReg.S0); // 裸数组指针(侧表键)
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_has_false");
        vm.mov(VReg.A0, VReg.RET); // props 对象
        vm.mov(VReg.A1, VReg.S1);  // key
        vm.call("_object_has");   // 递归:props 是 TYPE_OBJECT
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_object_has_ta_side");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_has_false");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

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

        // [W7b] Date own:侧表
        vm.label("_object_has_date_side");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_has_false");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // [I5] 函数值 own 判定(S0=裸闭包指针, S1=归一装箱键)。与 _ogopd_fn 同构
        // (gOPD(fn,k) !== undefined ⟺ hasOwn(fn,k)):
        //   name/length → _closure_prop_get(侧表优先;miss 落 _func_meta_name/_func_meta_arity——
        //                 键须换数据段字面量其地址比较才命中;未登记匿名函数名/无 arity 的
        //                 length → undefined → false,不编造 true);
        //   其余键 → 闭包属性侧表 props 对象判 has(普通对象,无递归;用 has 而非 get:
        //            fn.x=undefined 亦 own,与 node 同)。
        // 非字符串键(symbol 等)直落侧表分支(不把 tag 位当内容地址做 strcmp)。
        // 共用入口 _fn_has_own(A0=fn 任意形, A1=装箱键)→ RET=裸 0/1;_prop_in 的闭包分支同经
        // 此路(has/in/gOPD 三者 own 性一致)。
        vm.label("_object_has_fn");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_fn_has_own");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_fn_has_own");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // fn(装箱/裸皆可,受调方内部脱壳)
        vm.mov(VReg.S1, VReg.A1); // 装箱键
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_fho_side");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fho_name");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_fho_len");
        vm.label("_fho_side");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_fho_false");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has"); // props 普通对象;RET=裸 0/1 直接透传
        vm.epilogue([VReg.S0, VReg.S1], 0);
        // name/length:键换数据段字面量再传(_closure_prop_get 的元数据回落按 payload 与
        // addString 字面量的**地址**比较,堆串即便同内容不命中——同 _ogopd_fn_meta 再装箱)。
        vm.label("_fho_name");
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.jmp("_fho_meta");
        vm.label("_fho_len");
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.label("_fho_meta");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_prop_get"); // 侧表 → 元数据回落;彻底无值 → undefined
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_fho_false");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_fho_false");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
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

        // [I5] 闭包函数值先按全字 magic 判(0xc105/0xa51c;低字节 0x05 与 TYPE_SET 撞,且按
        // 对象头读 count/props_ptr 是垃圾解引用)。own 判定经 _fn_has_own(与 _ogopd_fn /
        // _object_has fn 分支同构)。in 语义还应走原型链(fn → Function.prototype →
        // Object.prototype),但 Function.prototype 未物化成对象,故不走:"call" in f /
        // "toString" in f 为 false(记偏差,与 _object_gopn_fn 不含 'prototype' 同源);
        // name/length/侧表键为 true,与 gOPD 一致。
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0xc105);
        vm.jeq("_prop_in_fn");
        vm.cmpImm(VReg.V1, 0xa51c);
        vm.jeq("_prop_in_fn");
        // TEXT class methods before TA range (same hole as _object_has).
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_func_meta_entry");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_fn");
        // [in] 数组(TYPE_ARRAY=1):数值键 `"i" in arr ≡ 0<=i<length && 槽!=0`(真 hole)。
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
        // Date(7)/Promise(11):ts/status 被当 count 野扫(`"foo" in date` SIGSEGV 根因)。
        vm.cmpImm(VReg.V0, TYPE_DATE);
        vm.jeq("_prop_in_date_side");
        vm.cmpImm(VReg.V0, TYPE_PROMISE);
        vm.jeq("_prop_in_date_side");
        // TEXT already handled above (before TA).
        vm.jmp("_prop_in_obj");

        // Date/Promise own named properties live in the closure side table;
        // ask the layout-aware own-property helper instead of interpreting
        // timestamp/status as an ordinary object's property count.
        vm.label("_prop_in_date_side");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_true");
        vm.jmp("_prop_in_false");

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
        vm.jlt("_prop_in_idx_named");
        vm.cmpImm(VReg.V0, 57); // '9'
        vm.jgt("_prop_in_idx_named");
        vm.subImm(VReg.V0, VReg.V0, 48);
        vm.movImm(VReg.V1, 10);
        vm.mul(VReg.V3, VReg.V3, VReg.V1);
        vm.add(VReg.V3, VReg.V3, VReg.V0);
        vm.movImm(VReg.S3, 1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_prop_in_arr_atoi");
        vm.label("_prop_in_arr_done");
        vm.cmpImm(VReg.S3, 0);   // 空键 "" → 具名属性路径
        vm.jeq("_prop_in_idx_named");
        // TypedArray:OOB 视图按活长度判;勿读陈旧 length@8( rab.resize 后仍保留旧长)。
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY → 下方 length@8
        vm.jeq("_prop_in_arr_len");
        vm.cmpImm(VReg.V0, TYPE_TA_LO);
        vm.jlt("_prop_in_arr_len");
        vm.cmpImm(VReg.V0, TYPE_TA_HI);
        vm.jgt("_prop_in_arr_len");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.cmp(VReg.V3, VReg.RET);
        vm.jge("_prop_in_false");
        vm.jmp("_prop_in_true");
        vm.label("_prop_in_arr_len");
        vm.load(VReg.S2, VReg.S0, 8); // length @ block+8
        vm.cmp(VReg.V3, VReg.S2);
        vm.jge("_prop_in_arr_side");
        // TypedArray:界内即 true。TYPE_ARRAY:槽!=0 才 true(hole 哨兵 0)。
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jne("_prop_in_true");
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V0, VReg.V3, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_prop_in_true");
        vm.label("_prop_in_arr_side");
        // 稠密 hole / 越界:侧表 accessor 仍是 own(`'2' in arr` after defineProperty)
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_prop_in_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V3);
        vm.call("_array_side_elem_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_true");
        vm.label("_prop_in_arr_proto");
        // OrdinaryHasProperty continues through an array instance's custom
        // prototype after own/side-table misses. The override is boxed (tagged
        // null terminates the chain); recurse with the original key.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_get_instance_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_arr_proto_ready");
        // No per-instance override means the intrinsic Array.prototype, not
        // the end of the chain.  The intrinsic array itself has an explicit
        // Object.prototype override, so recursion then continues normally.
        vm.call("_ensure_array_proto");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prop_in_false");
        vm.label("_prop_in_arr_proto_ready");
        // x64 V0 aliases RET: extracting the tag into V0 would replace the
        // boxed prototype with 0x7FFD before _js_unbox and dereference 0x7FFD.
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_prop_in_false");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_unbox");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_prop_in");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // Named TypedArray keys: first consult ordinary side-table properties,
        // then continue with the concrete TypedArray prototype chain.
        vm.label("_prop_in_idx_named");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jeq("_prop_in_arr_named");
        vm.cmpImm(VReg.V0, TYPE_TA_LO);
        vm.jlt("_prop_in_false");
        vm.cmpImm(VReg.V0, TYPE_TA_HI);
        vm.jgt("_prop_in_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_prop_in_ta_proto");
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_true");
        vm.label("_prop_in_ta_proto");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_getprototypeof");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_prop_in_false");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_prop_in_false");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_prop_in");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        vm.label("_prop_in_arr_named");
        // Array's exotic length is always an own property.
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prop_in_true");
        // Other named/Symbol-like string keys live in the shared side table.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_prop_in_arr_proto");
        vm.mov(VReg.A0, VReg.RET);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_true");
        vm.jmp("_prop_in_arr_proto");
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
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_priv_key");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_proxy_priv");
        vm.load(VReg.S2, VReg.S0, 8);   // target(装箱)
        vm.load(VReg.S3, VReg.S0, 16);  // handler(装箱)
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, this.vm.asm.addString("has"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prop_in_proxy_fwd");
        // 调 has(target, key);_aref_invoke_cb 分派(this=undefined)
        // Preserve the trap before assembling arguments: arm64 RET aliases A0,
        // while x64 A3 aliases V1.  S3 (the now-dead handler) avoids both.
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);       // target
        // x64 V1 aliases A3 (RCX): finish boxing the key before loading the
        // trap into A3, otherwise the tag mask replaces the callback.
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S1, VReg.V1); // 装箱键(content→string)
        vm.lea(VReg.A2, "_js_undefined");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.mov(VReg.A3, VReg.S3);       // callback (last, after V1 scratch)
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
        vm.label("_prop_in_proxy_priv");
        vm.load(VReg.A0, VReg.S0, 24);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_pip_priv_proto");
        vm.mov(VReg.S2, VReg.A0);
        vm.shrImm(VReg.V2, VReg.S1, 48);
        vm.cmpImm(VReg.V2, 0x7FFC);
        vm.jeq("_pip_priv_keyok");
        vm.movImm64(VReg.V2, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S1, VReg.V2);
        vm.jmp("_pip_priv_haskey");
        vm.label("_pip_priv_keyok");
        vm.mov(VReg.A1, VReg.S1);
        vm.label("_pip_priv_haskey");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_true");
        vm.label("_pip_priv_proto");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_js_unbox");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prop_in_false");
        vm.loadByte(VReg.V2, VReg.RET, 0);
        vm.cmpImm(VReg.V2, 2);
        vm.jeq("_pip_priv_ldproto");
        vm.cmpImm(VReg.V2, 3);
        vm.jne("_prop_in_false");
        vm.label("_pip_priv_ldproto");
        vm.load(VReg.A0, VReg.RET, 16);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_prop_in_false");
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_prop_in");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // [I5] 闭包函数值(S0=裸闭包, S1=键 content 指针):content 指针 OR 0x7FFC 装箱
        // (同 _prop_in_proxy :3212 的 content→string 形态,_getStrContent 认),委托
        // _fn_has_own(own 性同构 gOPD;原型链不走,见 _prop_in 头注)。
        vm.label("_prop_in_fn");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.S1, VReg.V1); // 装箱键
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_fn_has_own");         // RET = 裸 0/1
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_prop_in_true");
        // 继承键(含 Function.prototype 上可枚举字段):走原型链,不触发
        // _closure_prop_get(fun,"caller") 抛错(test262 13.2-18-1 verifyProperty/for-in)。
        // S0 已在入口脱壳;gPO 的 0x7FFF 分派须装箱 fn 值(bind 继承 prop,15.2.3.6-4-595)。
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.A0, VReg.S0, VReg.V2);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_object_getPrototypeOf");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_prop_in_false");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);       // 键 content 指针(同入口形态)
        vm.call("_prop_in");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
    }

    // _object_forin_keys(obj) -> 装箱键数组
    // for-in 序:自有可枚举串键 → 原型链上未被遮蔽的可枚举串键。
    // 栈槽:[SP+0]=本层键数组,[SP+8]=i;S0=结果(装箱),S1=当前对象,S2=seen,S3=键,S4=len。
    generateObjectForInKeys() {
        const vm = this.vm;
        vm.label("_object_forin_keys");
        vm.prologue(24, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A0); // 当前对象
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size"); // 裸头
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.S0, VReg.RET, VReg.V1); // 结果(装箱)
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET); // seen
        vm.store(VReg.SP, 16, VReg.S2); // 保活 seen(_ensure_function_proto 等会腐蚀 S2)
        vm.label("_ofk_obj");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_ofk_done");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_ofk_done");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_ofk_done");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_ofk_keys");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_ofk_keys");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_ofk_keys");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ofk_done");
        vm.label("_ofk_keys");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_keys");
        vm.label("_ofk_keys_got");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.S4, VReg.V0, 8);
        vm.movImm(VReg.S5, 0);
        vm.store(VReg.SP, 8, VReg.S5);
        vm.load(VReg.S2, VReg.SP, 16); // 重载 seen(防上一步子调用腐蚀 S2)
        vm.label("_ofk_i");
        vm.load(VReg.S5, VReg.SP, 8);
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge("_ofk_next_proto");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_array_get");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ofk_i_next");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm64(VReg.A2, 0x7FF9000000000001n); // true
        // Internal [[Seen]] bookkeeping is a CreateDataProperty operation;
        // using [[Set]] would invoke a user-installed Object.prototype setter
        // (notably the empty-string setter in JSON wrapper tests).
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_push_own");
        vm.mov(VReg.S0, VReg.RET);
        vm.label("_ofk_i_next");
        vm.load(VReg.S5, VReg.SP, 8);
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.store(VReg.SP, 8, VReg.S5);
        vm.jmp("_ofk_i");
        vm.label("_ofk_next_proto");
        // 自有全量串键(含不可枚举)记入 seen,遮蔽原型同名可枚举键(12.6.4-2)。
        // 可枚举键已在上环 yield 时写入;此处幂等覆写。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_own_keys");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.load(VReg.S4, VReg.V0, 8);
        vm.movImm(VReg.S5, 0);
        vm.store(VReg.SP, 8, VReg.S5);
        vm.load(VReg.S2, VReg.SP, 16);
        vm.label("_ofk_seen_i");
        vm.load(VReg.S5, VReg.SP, 8);
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge("_ofk_seen_done");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_array_get");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm64(VReg.A2, 0x7FF9000000000001n);
        vm.call("_object_define");
        vm.load(VReg.S5, VReg.SP, 8);
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.store(VReg.SP, 8, VReg.S5);
        vm.jmp("_ofk_seen_i");
        vm.label("_ofk_seen_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_getPrototypeOf");
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.S2, VReg.SP, 16); // 重载 seen(防 getPrototypeOf 腐蚀 S2)
        vm.jmp("_ofk_obj");
        vm.label("_ofk_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 24);
    }

    // Object.keys(obj) -> 返回包含所有键的数组
    // _object_keys(obj) -> array
    generateObjectKeys() {
        const vm = this.vm;

        // _is_mangled_private_name(A0=C string) -> 1 if `#Class#field` (two '#').
        // Public computed keys like ["#constructor"] have only the leading '#'.
        vm.label("_is_mangled_private_name");
        vm.prologue(0, []);
        vm.loadByte(VReg.V0, VReg.A0, 0);
        vm.cmpImm(VReg.V0, 0x23); // '#'
        vm.jne("_imn_no");
        vm.movImm(VReg.V1, 1);
        vm.label("_imn_loop");
        vm.add(VReg.V2, VReg.A0, VReg.V1);
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_imn_no");
        vm.cmpImm(VReg.V0, 0x23);
        vm.jeq("_imn_yes");
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_imn_loop");
        vm.label("_imn_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);
        vm.label("_imn_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([], 0);

        // [gOPN] 同一遍历体两个入口,只差"是否按 enumerable 过滤"这一位(S5):
        //   _object_keys(obj)      → S5=0,跳过 enumerable:false(Object.keys 语义)
        //   _object_own_keys(obj)  → S5=1,收全部自有非 symbol 键(gOPN 语义)
        // 单 prologue 共用,避免复制整段枚举代码。
        vm.label("_object_own_keys_all");
        vm.movImm(VReg.A1, 2); // 全量自有键含 symbol(Proxy ownKeys 不变式)
        vm.jmp("_object_keys_entry");
        vm.label("_object_own_keys");
        vm.movImm(VReg.A1, 1);
        vm.jmp("_object_keys_entry");
        vm.label("_object_keys");
        vm.movImm(VReg.A1, 0);
        vm.label("_object_keys_entry");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S5, VReg.A1); // 0=按 enumerable 过滤,1=全量自有键

        // [test262 S1] 类型分派(消 CRASH):非对象目标按规范处理,绝不按 plain 布局解引用
        // count@8/props_ptr(此前 null/数值/数组/串脱壳后读 [垃圾+0] → SIGSEGV)。
        // null/undefined → TypeError;array/string → 索引键 ["0",...];int/bool → 空数组;
        // object(0x7FFD)/裸指针(classinfo)→ 原路径;function(0x7FFF)→ 侧表专路(见
        // _object_keys_fn:函数无对象头,按 plain 布局解引用即崩)。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_keys_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_keys_nullish");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_keys_indexed");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_keys_indexed_str");
        // number/bool → 空数组。注意 number 大多是**裸 float 位**(5.0 → high16=0x4014),
        // 不是 0x7FF8 装箱 int——旧"复用空数组路径破坏堆"实为 float 未被分派、掉进 legacy
        // 解引用踩内存(空数组路径本身无辜,bool 实测干净)。判别:0x7FF8(装箱 int/NaN 别名)
        // /0x7FF9(bool)→ 空;0x7FFD(对象)→ 原路径;0x7FFF(函数)→ 侧表专路;其余 high16≠0 → 裸
        // float → 空;high16==0 且全零 → float +0.0 → 空;high16==0 且非零 → 裸堆指针
        // (Map/Set/classinfo/Symbol)→ 原路径。
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_object_keys_empty");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_object_keys_empty");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_keys_legacy");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_keys_fn");
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_keys_empty"); // 其余非零 high16 = 裸 float
        vm.cmpImm(VReg.A0, 0); vm.jeq("_object_keys_empty"); // 全零 = +0.0
        vm.label("_object_keys_legacy");

        vm.mov(VReg.S0, VReg.A0); // obj

        // 指针脱壳
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);

        // Symbol(61): raw heap pointer without NaN-box tag; has no own keys → empty array.
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_SYMBOL);
        vm.jeq("_object_keys_empty");
        // [W7b] Date:侧表键(不可按对象头扫 ts)
        vm.cmpImm(VReg.V0, TYPE_DATE);
        vm.jeq("_object_keys_date");
        // TypedArray(0x40-0x7f):自有键是活长度下的 "0".."n-1"。按对象头扫会把
        // length@8 当 count、内联元素当 props_ptr。OOB/detached → _typed_array_length=0。
        vm.cmpImm(VReg.V0, TYPE_TA_LO);
        vm.jlt("_object_keys_not_ta");
        vm.cmpImm(VReg.V0, TYPE_TA_HI);
        vm.jle("_object_keys_ta");
        vm.label("_object_keys_not_ta");

        // Proxy(type=8):有 ownKeys 陷阱 → handler.ownKeys(target) 的键数组;否则转发
        // target 的键(count@8 是 target 指针,不转发会当 count 迭代垃圾崩)。**偏差**:
        // Object.keys 严格应按 getOwnPropertyDescriptor 过滤 enumerable,此处返陷阱全量键
        // (Reflect.ownKeys 语义;gOPN 在不变式检查后滤掉 symbol)。
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
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_proxy_ownkeys_to_list");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_proxy_ownkeys_validate");
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_object_keys_proxy_enum");
        vm.cmpImm(VReg.S5, 1);
        vm.jne("_object_keys_proxy_ret");
        // gOPN: validate full trap (incl. symbols) then keep strings only.
        vm.label("_object_keys_proxy_filter_strings");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.S4, 0);
        vm.label("_object_keys_proxy_filt");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_object_keys_proxy_filt_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_keys_proxy_filt_next");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_keys_proxy_filt_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_object_keys_proxy_filt");
        vm.label("_object_keys_proxy_filt_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.S2, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_object_keys_proxy_ret");
        // CreateArrayFromList: trap result must be a *new* array (spec [[OwnPropertyKeys]]).
        // Returning the handler array by identity fails
        // getOwnPropertyDescriptors/proxy-undefined-descriptor
        // (Reflect.ownKeys(p) === ownKeys).
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.S4, 0);
        vm.label("_object_keys_proxy_copy");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_object_keys_proxy_copy_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_object_keys_proxy_copy");
        vm.label("_object_keys_proxy_copy_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.S2, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_object_keys_proxy_enum");
        // EnumerableOwnPropertyNames: after the one validated ownKeys snapshot,
        // query [[GetOwnProperty]] for every String key and keep enumerable ones.
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.S4, 0);
        vm.label("_object_keys_proxy_enum_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_object_keys_proxy_enum_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.S5, VReg.RET); // current key (mode no longer needed)
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_keys_proxy_enum_next");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_object_keys_proxy_enum_next");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("enumerable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_proxy_enum_next");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_keys_proxy_enum_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_object_keys_proxy_enum_loop");
        vm.label("_object_keys_proxy_enum_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.S2, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_object_keys_proxy_fwd");
        // Missing trap → target.[[OwnPropertyKeys]]. Honor S5 so
        // _object_own_keys_all keeps symbols (isFrozen/proxy-no-ownkeys order).
        vm.load(VReg.A0, VReg.S0, 8); // target(装箱)
        vm.cmpImm(VReg.S5, 2);
        vm.jeq("_object_keys_proxy_fwd_all");
        vm.cmpImm(VReg.S5, 1);
        vm.jeq("_object_keys_proxy_fwd_own");
        vm.call("_object_all_own_keys");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_object_keys_proxy_enum");
        vm.label("_object_keys_proxy_fwd_own");
        vm.call("_object_all_own_keys");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_object_keys_proxy_filter_strings");
        vm.label("_object_keys_proxy_fwd_all");
        vm.call("_object_all_own_keys");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
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

        // 可枚举判别:S5==1(gOPN 全量)→ 收;flags_ptr==0 → 收;
        // 否则 flags[idx]&ATTR_ENUMERABLE==0 → 跳过
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_object_keys_take");
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

        // classinfo(type=3):Object.keys(S5=0)仍藏 __ctor__/prototype(idx<2)与方法;
        // gOPN(S5=1)只藏内部槽 __ctor__,prototype/length/name/静态方法须出现。
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_object_keys_ci_ok");
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_object_keys_ci_gopn");
        vm.cmpImm(VReg.S3, 2);
        vm.jlt("_object_keys_next"); // __ctor__/prototype
        vm.load(VReg.V1, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.V1, VReg.V1, 8); // value
        vm.shrImm(VReg.V1, VReg.V1, 48);
        vm.cmpImm(VReg.V1, 0x7FFF); // function → 方法,跳过
        vm.jeq("_object_keys_next");
        vm.jmp("_object_keys_ci_ok");
        vm.label("_object_keys_ci_gopn");
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_keys_ci_ok");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("__ctor__"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_next");
        vm.label("_object_keys_ci_ok");

        // symbol 键排除:Object.keys/values/entries/for-in 不含 symbol 键
        // (symbol 键属 getOwnPropertySymbols)。_is_symbol 保存 S0-S4。
        // S5==2 (_object_own_keys_all):保留 symbol,供 Proxy [[OwnPropertyKeys]] 不变式。
        vm.cmpImm(VReg.S5, 2);
        vm.jeq("_object_keys_not_intslot");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_keys_next");

        // Property tables created during host/global initialisation may retain
        // a raw interned string pointer as the key.  OwnPropertyKeys must expose
        // a String value, not that pointer's numeric bit pattern.  Symbols were
        // filtered immediately above, so every remaining raw key is a string.
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_object_keys_key_boxed");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_js_box_string");
        vm.mov(VReg.S4, VReg.RET);
        vm.label("_object_keys_key_boxed");

        // [L1-Object] 包装内部槽名过滤(双保险:即便旧对象 flags 未标非枚举,keys/gOPN
        // 也不暴露 `__boolean_value`/`__number_value`)。
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_keys_not_intslot");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("__boolean_value"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_next");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_next");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("__bigint_value"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_next");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_next");
        vm.label("_object_keys_not_intslot");

        // [W-47] 过滤 mangled 私有键 `#Class#field`(两段 #)。公有 `["#constructor"]`
        // 只有首 #,须出现在 Object.keys/for-in/gOPN。S4 是 NaN-boxed string(0x7FFC)。
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_keys_push");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_mangled_private_name");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_keys_next");

        vm.label("_object_keys_push");
        // push 到结果数组
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push_own");
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // ---- [test262 S1] 非对象目标分派处理(入口 high16 分派跳入)----
        // null/undefined → TypeError(ToObject 规范)
        vm.label("_object_keys_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        // number/bool → 空数组(S1=0 走通用索引键构建,即空结果)
        vm.label("_object_keys_empty");
        vm.movImm(VReg.S0, 0); // 无侧表合并
        vm.movImm(VReg.S1, 0);
        vm.jmp("_object_keys_idx_build");

        // TypedArray → 索引键 ["0",...,"liveLen-1"] + 具名侧表键
        vm.label("_object_keys_ta");
        vm.mov(VReg.A0, VReg.S0); // 裸 TA(_typed_array_length 接受装箱/裸)
        vm.call("_typed_array_length");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_object_keys_idx_build");

        // array → 索引键 ["0",...,"len-1"] + 具名侧表键(arr.foo / Arguments 具名属性)
        vm.label("_object_keys_indexed");
        vm.mov(VReg.S0, VReg.A0); // 保装箱数组,供 idx_done 合并侧表
        vm.call("_array_length"); // A0=boxed array → RET=length
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_object_keys_idx_build");
        // string → 索引键(字节长;ASCII = 字符数,非 ASCII 见 UTF-8 偏差)
        vm.label("_object_keys_indexed_str");
        vm.movImm(VReg.S0, 0); // 字符串无具名侧表
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
        vm.mov(VReg.S4, VReg.RET);
        // Strings and TypedArrays have every in-range index.  Array/Arguments
        // indices may be holes or may have a side-table descriptor installed by
        // defineProperty; the latter descriptor's enumerable bit controls keys
        // and for-in even when a dense slot also exists.
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_keys_idx_emit");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY / Arguments
        vm.jne("_object_keys_idx_emit");
        vm.loadByte(VReg.V0, VReg.V2, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_HAS_SIDETABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_keys_idx_dense");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_keys_idx_dense");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_keys_idx_dense");
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_object_keys_idx_emit");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("enumerable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_idx_next");
        vm.jmp("_object_keys_idx_emit");
        vm.label("_object_keys_idx_dense");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.load(VReg.V1, VReg.V2, 16); // physical capacity
        vm.cmp(VReg.S3, VReg.V1);
        vm.jge("_object_keys_idx_next"); // sparse logical range has no dense slot
        vm.load(VReg.V1, VReg.V2, 24); // data_ptr
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_keys_idx_next");
        vm.shl(VReg.V0, VReg.S3, 3);
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_keys_idx_next"); // hole
        vm.label("_object_keys_idx_emit");
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_keys_idx_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_keys_idx_loop");
        vm.label("_object_keys_idx_done");
        // [L1-Object] 数组合并闭包侧表具名键:Object.keys([]) 仍 [],但 `a=[];a.prop=1`
        // / Arguments 上的具名属性须出现(Object.create({}, arrayOrArgsAsProps))。
        // S0=装箱数组(索引路)或 0(字符串/空)。S5 保留 keys vs own_keys 过滤位。
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_keys_idx_box");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_keys_idx_box");
        vm.mov(VReg.A0, VReg.RET); // 侧表 props 普通对象
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_object_keys_idx_side_own");
        vm.call("_object_keys");
        vm.jmp("_object_keys_idx_side_got");
        vm.label("_object_keys_idx_side_own");
        vm.call("_object_own_keys");
        vm.label("_object_keys_idx_side_got");
        vm.mov(VReg.S4, VReg.RET); // 侧表键数组(装箱)
        // S1 still holds the dense length from idx_build. defineProperty on
        // an in-range index seeds that key onto the side table (attrs);
        // merging it again made Object.keys(["foo"]) → "0","0" after
        // defineProperty("0", {value:"foo",…}) and broke JSON reviver
        // expectedKeys.splice(1, 0, ...Object.keys(replacement)).
        vm.movImm(VReg.S3, 0);
        vm.label("_object_keys_idx_side_loop");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_array_length");
        vm.cmp(VReg.S3, VReg.RET);
        vm.jge("_object_keys_idx_box");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_canonical_array_index");
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_keys_idx_side_take"); // named / non-index
        vm.cmp(VReg.RET, VReg.S1);
        vm.jlt("_object_keys_idx_side_next"); // already emitted as dense 0..len-1
        vm.label("_object_keys_idx_side_take");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        // Arguments has an own legacy `callee` slot, but it is non-enumerable.
        // The compact arguments side table does not otherwise need to expose
        // that internal default attribute through Object.keys/for-in.
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_object_keys_idx_side_push");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 1);
        vm.andImm(VReg.V1, VReg.V1, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_keys_idx_side_push");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("callee"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_keys_idx_side_next");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.label("_object_keys_idx_side_push");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_keys_idx_side_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_keys_idx_side_loop");
        vm.label("_object_keys_idx_box");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // [W-16] 函数接收者(0x7FFF)专路。函数值**不是** plain 属性容器:脱壳后指向闭包块
        // {magic@0(0xc105/0xa51c), code_ptr@8, 捕获槽...} 或裸代码指针,既无 count@8 也无
        // props_ptr@32。此前与 0x7FFD 共用 legacy 路径,把 code_ptr 当 count(天文数字)、把
        // 块外邻居当 props 数组基址迭代 → 确定性 SIGSEGV(Object.keys(fn) /
        // Object.getOwnPropertyNames(fn),后者亦是 Object.defineProperties(o, fnAsMap)
        // desugar 的崩因)。函数的自有具名属性挂在 _closure_props_* 侧表(与 _object_get 的
        // 0x7FFF 分支同表),故转为枚举侧表 props 普通对象(TYPE_OBJECT,不会再落本分支,
        // 无递归环);从未写过 fn.x → 侧表 miss → 空数组。
        // [W7b] Date keys → 侧表(与函数同形,无 length/name 过滤)
        vm.label("_object_keys_date");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_keys_empty");
        vm.mov(VReg.A0, VReg.RET);
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_object_keys_date_own");
        vm.call("_object_keys");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_object_keys_date_own");
        vm.call("_object_own_keys");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);

        // [W7b] Date keys → 侧表(与函数同形,无 length/name 过滤)
        vm.label("_object_keys_fn");
        vm.mov(VReg.S4, VReg.A0); // 保存 fn(枚举序: length/name/prototype 创建早于侧表后挂键)
        vm.call("_closure_props_find"); // A0=fn 值 → RET=props(装箱 0x7FFD)/undefined
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_keys_empty");
        vm.mov(VReg.A0, VReg.RET);
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_object_keys_fn_own");
        // Object.keys(fn):创建序 = [length?, name?, prototype?](仅当侧表 enumerable) +
        // 其余侧表键。DefineOwnProperty 不改创建序——故三键前置,再扫侧表跳过它们。
        vm.mov(VReg.S0, VReg.RET); // props
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET); // 裸结果
        for (const nm of ["length", "name", "prototype"]) {
            const pfx = `_okfn_${nm}`;
            vm.mov(VReg.A0, VReg.S4); // fn
            vm.lea(VReg.A1, vm.asm.addString(nm));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.call("_closure_prop_attr"); // RET=attr / 0x100 absent
            vm.movImm(VReg.V1, 0x100);
            vm.cmp(VReg.RET, VReg.V1);
            vm.jeq(`${pfx}_skip`);
            // 内建 _closure_prop_set 落 DEFAULT(7) 不当枚举;仅 defineProperty 改过的 attr 才进 keys
            vm.cmpImm(VReg.RET, ATTR_DEFAULT);
            vm.jeq(`${pfx}_skip`);
            vm.andImm(VReg.V0, VReg.RET, ATTR_ENUMERABLE);
            vm.cmpImm(VReg.V0, 0);
            vm.jeq(`${pfx}_skip`);
            vm.lea(VReg.A1, vm.asm.addString(nm));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_array_push_own");
            vm.mov(VReg.S2, VReg.RET);
            vm.label(`${pfx}_skip`);
        }
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_keys");
        vm.mov(VReg.S0, VReg.RET);      // 源键数组(装箱)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET);      // len
        vm.movImm(VReg.S3, 0);          // i
        vm.label("_object_keys_fnf_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_keys_fnf_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET);      // key
        // 非字符串形态的键直接收下,不进 _strcmp(避免拿 tag 位当地址解引用)
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_keys_fnf_push");
        // length/name/prototype 已按创建序前置处理 → 侧表再扫到时跳过
        for (const nm of ["length", "name", "prototype"]) {
            vm.mov(VReg.A0, VReg.S4);
            vm.call("_getStrContent");  // 装箱串 → 内容指针
            vm.mov(VReg.A0, VReg.RET);
            vm.lea(VReg.A1, vm.asm.addString(nm));
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq("_object_keys_fnf_next");
        }
        vm.label("_object_keys_fnf_push");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_keys_fnf_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_keys_fnf_loop");
        vm.label("_object_keys_fnf_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_object_keys_fn_own");
        vm.call("_object_own_keys");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // Object.getOwnPropertyNames(obj) -> array
    // _object_gopn(obj) -> array
    // [test262 S1] 与 _object_keys 的差异仅在 array/string:索引键之外还含 "length"
    // (node: gOPN([a,b]) = ['0','1','length'],gOPN('ab') = ['0','1','length'])。
    // null/undefined → TypeError;函数 → ['length','name'] + 属性侧表键(见 _object_gopn_fn);
    // 对象/裸指针/原语 → 委托 _object_own_keys(简化模型:自有键全量,不按 enumerable 过滤)。
    generateObjectGetOwnPropertyNames() {
        const vm = this.vm;

        vm.label("_object_gopn");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_gopn_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_gopn_nullish");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_gopn_arr");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_gopn_str");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_gopn_fn"); // [W-16] 函数:+ length/name
        // 其余形态:委托全量自有键入口(A0 未动)。gOPN 不按 enumerable 过滤:
        // defineProperty(o,k,{enumerable:false}) 的键仍须出现(node 语义)。
        vm.mov(VReg.S0, VReg.A0); // 保目标,供 classinfo 序修正
        vm.call("_object_own_keys");
        // RET = boxed key array. x64 V0≡RET: tag/unbox of S0 must use V2, else
        // shrImm(V0,S0,48) turns the result into 0x7FFD and gOPN({a:1}).length
        // becomes garbage (~-2^63). V2≡A2, A2 is dead after _object_own_keys.
        // 仅对象(0x7FFD)或裸堆指针才读 type 字节。bool(0x7FF9)载荷 0/1 当指针会 SIGSEGV。
        vm.shrImm(VReg.V2, VReg.S0, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jeq("_object_gopn_ci_chk");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_object_gopn_keys_done");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_gopn_keys_done");
        vm.label("_object_gopn_ci_chk");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_gopn_keys_done");
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_object_gopn_keys_done");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_gopn_classinfo_order");
        vm.label("_object_gopn_keys_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // null/undefined → TypeError(ToObject 规范)
        vm.label("_object_gopn_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        vm.label("_object_gopn_arr");
        vm.mov(VReg.S0, VReg.A0);       // 保装箱数组,供 idx_done 合并侧表
        vm.call("_array_length");       // A0=boxed array → RET=length
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_object_gopn_build");
        vm.label("_object_gopn_str");
        vm.movImm(VReg.S0, 0);          // 字符串无具名侧表
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
        // Holes are not own properties (OrdinaryOwnPropertyKeys).
        // defineProperty(arr,"length",{value:2}) on [] must stay [length,a]
        // not [0,1,length,a]. Strings (S0=0) have no holes.
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_gopn_idx_emit");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.load(VReg.V1, VReg.V2, 24); // data_ptr
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_gopn_idx_next");
        vm.shl(VReg.V0, VReg.S3, 3);
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_object_gopn_idx_next");
        vm.label("_object_gopn_idx_emit");
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0); // A0 = i 的 float64 位
        vm.call("_valueToStr");         // RET = boxed 字符串键
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_gopn_idx_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_gopn_idx_loop");
        vm.label("_object_gopn_idx_done");
        // + "length"(数据段字面量拷进堆并装箱)
        vm.lea(VReg.A0, vm.asm.addString("length"));
        vm.call("_cstr_to_heap_str");   // RET = boxed 堆串
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        // 具名侧表键(defineProperty(arr,"ownProperty",…) / arr.foo)。跳过已前置的
        // "length",避免重复。索引键若也在侧表会重复——与 Object.keys 数组合并同偏差。
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_gopn_arr_box");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find"); // RET = props(装箱 0x7FFD)/undefined
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_gopn_arr_box");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_own_keys");    // RET = 装箱键数组
        vm.mov(VReg.S0, VReg.RET);      // S0 复用为键数组
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET);      // len
        vm.movImm(VReg.S3, 0);          // i
        vm.label("_object_gopn_arr_side_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_gopn_arr_box");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");          // RET = 键
        vm.mov(VReg.S4, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_gopn_arr_side_push");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_gopn_arr_side_next");
        vm.label("_object_gopn_arr_side_push");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_gopn_arr_side_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_gopn_arr_side_loop");
        vm.label("_object_gopn_arr_box");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // [W-16] 函数(0x7FFF):node 的自有键 = ['length','name'(,'prototype')] + 后挂的
        // 具名属性。_object_own_keys 只能给出 _closure_props_* 侧表里的后挂键,故此处显式
        // 前置 length/name 再追加侧表键;侧表若已有同名键(如一等 Error 构造器在侧表挂了
        // .name)则去重,避免 gOPN(TypeError) 出两个 'name'。
        // **偏差**:不含 'prototype'——运行期无法区分箭头函数(node 无 prototype)与普通
        // 函数(node 有),宁缺勿多;length/name 只出现在键表,其**值**仍由 _closure_prop_get
        // 决定(name 有元数据反射,length 为 undefined)。
        vm.label("_object_gopn_fn");
        vm.mov(VReg.S0, VReg.A0);       // fn 值
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);      // 裸结果数组
        vm.lea(VReg.A0, vm.asm.addString("length"));
        vm.call("_cstr_to_heap_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.lea(VReg.A0, vm.asm.addString("name"));
        vm.call("_cstr_to_heap_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        // 侧表自有键(无侧表 → 只有 length/name)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find"); // RET = props(装箱 0x7FFD)/undefined
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_gopn_fn_done");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_own_keys");    // RET = 装箱键数组(symbol 键已被滤掉)
        vm.mov(VReg.S0, VReg.RET);      // S0 复用为键数组
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET);      // len
        vm.movImm(VReg.S3, 0);          // i
        vm.label("_object_gopn_fn_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_gopn_fn_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");          // RET = 键
        vm.mov(VReg.S4, VReg.RET);
        // 非字符串形态的键(理论上不该出现)直接收下,不进 _strcmp(避免拿 tag 当地址)
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_gopn_fn_push");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");      // 装箱串 → 内容指针
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_gopn_fn_next"); // 已前置
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_gopn_fn_next"); // 已前置
        vm.label("_object_gopn_fn_push");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_gopn_fn_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_gopn_fn_loop");
        vm.label("_object_gopn_fn_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // classinfo gOPN 键序:规范构造器先 length/name,再 MakeConstructor 的 prototype,
    // 然后静态方法。我们的槽序是 __ctor__/prototype/name/length/methods,须重排。
    generateObjectGopnClassinfoOrder() {
        const vm = this.vm;
        vm.label("_object_gopn_classinfo_order");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // boxed src keys
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        const prefs = ["length", "name", "prototype"];
        for (let pi = 0; pi < prefs.length; pi++) {
            const loopL = "_ogopn_ci_pref_loop_" + pi;
            const incL = "_ogopn_ci_pref_inc_" + pi;
            const nextL = "_ogopn_ci_pref_next_" + pi;
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_array_length");
            vm.mov(VReg.S1, VReg.RET);
            vm.movImm(VReg.S3, 0);
            vm.label(loopL);
            vm.cmp(VReg.S3, VReg.S1);
            vm.jge(nextL);
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_array_get");
            vm.mov(VReg.S4, VReg.RET);
            vm.shrImm(VReg.V0, VReg.S4, 48);
            vm.cmpImm(VReg.V0, 0x7FFC);
            vm.jne(incL);
            vm.mov(VReg.A0, VReg.S4);
            vm.call("_getStrContent");
            vm.mov(VReg.A0, VReg.RET);
            vm.lea(VReg.A1, vm.asm.addString(prefs[pi]));
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jne(incL);
            vm.mov(VReg.A0, VReg.S2);
            vm.mov(VReg.A1, VReg.S4);
            vm.call("_array_push_own");
            vm.mov(VReg.S2, VReg.RET);
            vm.jmp(nextL);
            vm.label(incL);
            vm.addImm(VReg.S3, VReg.S3, 1);
            vm.jmp(loopL);
            vm.label(nextL);
        }
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_ogopn_ci_rest_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_ogopn_ci_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_ogopn_ci_rest_push");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.S5, VReg.RET);
        for (let pi = 0; pi < prefs.length; pi++) {
            vm.mov(VReg.A0, VReg.S5);
            vm.lea(VReg.A1, vm.asm.addString(prefs[pi]));
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq("_ogopn_ci_rest_next");
        }
        vm.label("_ogopn_ci_rest_push");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_ogopn_ci_rest_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ogopn_ci_rest_loop");
        vm.label("_ogopn_ci_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // [L1 toString / symbol-tag-set-builtin] Set[@@iterator] 最小桩 + Iterator 原型 tag 链。
    // 仅服务 Object.prototype.toString 对 Set Iterator / Iterator 品牌串的反射面:
    // 不实现真 next() 遍历(调用 next 得 undefined/崩,记偏差)。数据槽:
    //   _nsobj_iterator_proto   @@toStringTag="Iterator"
    //   _nsobj_set_iter_proto   @@toStringTag="Set Iterator", __proto__→iterator_proto
    //   _set_iter_method_slot   惰性方法闭包(values 身份无关,仅可调用)
    generateSetIteratorStub() {
        const vm = this.vm;
        vm.asm.addDataLabel("_nsobj_iterator_proto");
        vm.asm.addDataQword(0);
        vm.asm.addDataLabel("_nsobj_set_iter_proto");
        vm.asm.addDataQword(0);
        vm.asm.addDataLabel("_set_iter_method_slot");
        vm.asm.addDataQword(0);

        // _ensure_set_iter_protos():惰性建 Iterator / Set Iterator 原型单例。
        vm.label("_ensure_set_iter_protos");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.lea(VReg.V0, "_nsobj_set_iter_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ensure_set_iter_protos_done");
        // Iterator.prototype
        vm.call("_object_new_raw");
        vm.mov(VReg.S0, VReg.RET); // 裸 iterator_proto
        vm.movImm64(VReg.V0, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V0);
        vm.lea(VReg.V1, "_nsobj_iterator_proto");
        vm.store(VReg.V1, 0, VReg.A0);
        // @@toStringTag = "Iterator"(attr 4 configurable)
        vm.lea(VReg.A0, "_symwk_toStringTag");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.S1, VReg.RET); // S1 = 符号键
        vm.lea(VReg.V0, "_nsobj_iterator_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.lea(VReg.A2, vm.asm.addString("Iterator"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V0);
        vm.call("_object_set");
        vm.lea(VReg.V0, "_nsobj_iterator_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 4); // configurable
        vm.call("_object_set_prop_attr");
        // SetIteratorPrototype
        vm.call("_object_new_raw");
        vm.mov(VReg.S0, VReg.RET);
        // __proto__ = 裸 Iterator.prototype
        vm.lea(VReg.V0, "_nsobj_iterator_proto");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.S0, 16, VReg.V1);
        vm.movImm64(VReg.V0, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V0);
        vm.lea(VReg.V1, "_nsobj_set_iter_proto");
        vm.store(VReg.V1, 0, VReg.A0);
        // @@toStringTag = "Set Iterator"
        vm.lea(VReg.A0, "_symwk_toStringTag");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.S1, VReg.RET);
        vm.lea(VReg.V0, "_nsobj_set_iter_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.lea(VReg.A2, vm.asm.addString("Set Iterator"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V0);
        vm.call("_object_define");
        vm.lea(VReg.V0, "_nsobj_set_iter_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 4);
        vm.call("_object_set_prop_attr");
        // MapIteratorPrototype mirrors SetIteratorPrototype but has its own
        // observable @@toStringTag and shares Iterator.prototype as parent.
        vm.call("_object_new_raw");
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V0, "_nsobj_iterator_proto");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.S0, 16, VReg.V1);
        vm.movImm64(VReg.V0, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V0);
        vm.lea(VReg.V1, "_nsobj_map_iter_proto");
        vm.store(VReg.V1, 0, VReg.A0);
        vm.lea(VReg.A0, "_symwk_toStringTag");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.S1, VReg.RET);
        vm.lea(VReg.V0, "_nsobj_map_iter_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.lea(VReg.A2, vm.asm.addString("Map Iterator"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V0);
        vm.call("_object_define");
        vm.lea(VReg.V0, "_nsobj_map_iter_proto");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 4);
        vm.call("_object_set_prop_attr");
        vm.lea(VReg.V0, "_nsobj_set_iter_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.label("_ensure_set_iter_protos_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _set_iterator_method_get() -> 装箱方法闭包(惰性)
        vm.label("_set_iterator_method_get");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.V0, "_set_iter_method_slot");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_set_iterator_method_get_done");
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_set_iterator_method");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.lea(VReg.V0, "_set_iter_method_slot");
        vm.store(VReg.V0, 0, VReg.RET);
        vm.label("_set_iterator_method_get_done");
        vm.epilogue([VReg.S0], 0);

        // _set_iterator_method(this=A5):返回 {[[Prototype]]:SetIteratorPrototype}
        vm.label("_set_iterator_method");
        vm.prologue(0, [VReg.S0]);
        vm.call("_ensure_set_iter_protos");
        vm.call("_object_new_raw");
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V0, "_nsobj_set_iter_proto");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.emitMaskLoad(VReg.V2);
        vm.andMaskReg(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.S0, 16, VReg.V1); // __proto__ = SetIteratorPrototype
        vm.movImm64(VReg.V0, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S0, VReg.V0);
        vm.epilogue([VReg.S0], 0);
    }

    // Safe Get(O, @@toStringTag) shared by Object.prototype.toString. Primitive
    // values are redirected to their materialized prototypes; compact exotics
    // whose instance headers cannot hold ordinary properties use their prototype
    // singleton as well. Returns undefined when no prototype has been materialized.
    generateObjectGetToStringTag() {
        const vm = this.vm;
        vm.label("_object_get_tostring_tag");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // original this value
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_ogtt_undef");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_ogtt_undef");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_ogtt_bool");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_ogtt_string");
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_ogtt_number");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_ogtt_direct");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_ogtt_direct");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_ogtt_function");
        vm.cmpImm(VReg.V0, 0); vm.jne("_ogtt_number"); // raw float
        vm.cmpImm(VReg.S0, 0); vm.jeq("_ogtt_number");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1); vm.jlt("_ogtt_number");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0); vm.jne("_ogtt_symbol");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jne("_ogtt_bigint");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_MAP); vm.jeq("_ogtt_map");
        vm.cmpImm(VReg.V0, TYPE_SET); vm.jeq("_ogtt_set");
        vm.cmpImm(VReg.V0, TYPE_PROMISE); vm.jeq("_ogtt_promise");
        vm.jmp("_ogtt_direct");

        vm.label("_ogtt_bool"); vm.lea(VReg.V0, "_nsobj_boolean_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_string"); vm.lea(VReg.V0, "_nsobj_string_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_number"); vm.lea(VReg.V0, "_nsobj_number_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_symbol"); vm.lea(VReg.V0, "_nsobj_symbol_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_bigint"); vm.lea(VReg.V0, "_nsobj_bigint_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_promise"); vm.lea(VReg.V0, "_nsobj_promise_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_map");
        vm.load(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0); vm.jne("_ogtt_weakmap");
        vm.lea(VReg.V0, "_nsobj_map_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_weakmap"); vm.lea(VReg.V0, "_nsobj_weakmap_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_set");
        vm.load(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0); vm.jne("_ogtt_weakset");
        vm.lea(VReg.V0, "_nsobj_set_proto"); vm.jmp("_ogtt_slot");
        vm.label("_ogtt_weakset"); vm.lea(VReg.V0, "_nsobj_weakset_proto");
        vm.label("_ogtt_slot");
        vm.load(VReg.S1, VReg.V0, 0);
        vm.cmpImm(VReg.S1, 0); vm.jeq("_ogtt_undef");
        vm.jmp("_ogtt_get");
        // Generator/Async/AsyncGenerator functions inherit @@toStringTag from
        // a distinct intrinsic prototype.  Function values are represented by
        // compact closure blocks, so recover their code pointer and use the
        // compiler metadata table to select that materialized prototype.
        vm.label("_ogtt_function");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);          // V0 = closure/raw code P
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105); vm.jeq("_ogtt_function_closure");
        vm.cmpImm(VReg.V1, 0xa51c); vm.jeq("_ogtt_function_closure");
        vm.mov(VReg.A0, VReg.V0);
        vm.jmp("_ogtt_function_kind");
        vm.label("_ogtt_function_closure");
        vm.load(VReg.A0, VReg.V0, 8);
        vm.label("_ogtt_function_kind");
        vm.call("_func_meta_find");
        vm.cmpImm(VReg.RET, 1); vm.jeq("_ogtt_genfunc");
        vm.cmpImm(VReg.RET, 2); vm.jeq("_ogtt_asyncfunc");
        vm.cmpImm(VReg.RET, 3); vm.jeq("_ogtt_asyncgenfunc");
        vm.jmp("_ogtt_direct");
        vm.label("_ogtt_genfunc");
        vm.call("_ensure_genfunc_tag_proto");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_ogtt_get");
        vm.label("_ogtt_asyncfunc");
        vm.call("_ensure_asyncfunc_tag_proto");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_ogtt_get");
        vm.label("_ogtt_asyncgenfunc");
        vm.call("_ensure_asyncgenfunc_tag_proto");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_ogtt_get");
        vm.label("_ogtt_direct");
        vm.mov(VReg.S1, VReg.S0);
        vm.label("_ogtt_get");
        vm.lea(VReg.A0, "_symwk_toStringTag");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_ogtt_done");
        // Some compiler paths represent a computed well-known key by its
        // canonical string alias. Consult that alias only for non-Proxies so
        // Proxy get traps retain the single-Get observable contract.
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jne("_ogtt_alias");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY); vm.jeq("_ogtt_done");
        vm.label("_ogtt_alias");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.label("_ogtt_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_ogtt_undef");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Iterator prototype singletons used by the Array/String iterator shims.
    // They are ordinary objects so test262 can mutate/delete @@toStringTag on
    // the prototype and Object.prototype.toString observes the change.
    generateIndexedIteratorProtos() {
        const vm = this.vm;
        for (const [slot, tag] of [["_nsobj_array_iter_proto", "Array Iterator"], ["_nsobj_string_iter_proto", "String Iterator"]]) {
            vm.asm.addDataLabel(slot);
            vm.asm.addDataQword(0);
            vm.label(slot + "_ensure");
            vm.prologue(0, [VReg.S0, VReg.S1]);
            vm.lea(VReg.V0, slot);
            vm.load(VReg.RET, VReg.V0, 0);
            vm.cmpImm(VReg.RET, 0);
            vm.jne(slot + "_done");
            vm.call("_ensure_set_iter_protos");
            vm.call("_object_new_raw");
            vm.mov(VReg.S0, VReg.RET);
            vm.lea(VReg.V0, "_nsobj_iterator_proto");
            vm.load(VReg.V1, VReg.V0, 0);
            vm.emitMaskLoad(VReg.V2);
            vm.andMaskReg(VReg.V1, VReg.V1, VReg.V2);
            vm.store(VReg.S0, 16, VReg.V1);
            vm.lea(VReg.A0, "_symwk_toStringTag");
            vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
            vm.call("_symbol_wellknown");
            vm.mov(VReg.S1, VReg.RET);
            vm.movImm64(VReg.V1, 0x7ffd000000000000n);
            vm.or(VReg.A0, VReg.S0, VReg.V1);
            vm.lea(VReg.V1, slot);
            vm.store(VReg.V1, 0, VReg.A0);
            vm.lea(VReg.A0, "_symwk_toStringTag");
            vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
            vm.call("_symbol_wellknown");
            vm.mov(VReg.S1, VReg.RET);
            vm.lea(VReg.V0, slot); vm.load(VReg.A0, VReg.V0, 0);
            vm.mov(VReg.A1, VReg.S1);
            vm.lea(VReg.A2, vm.asm.addString(tag));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V0);
            vm.call("_object_define");
            vm.lea(VReg.V0, slot); vm.load(VReg.A0, VReg.V0, 0);
            vm.mov(VReg.A1, VReg.S1); vm.movImm(VReg.A2, 4);
            vm.call("_object_set_prop_attr");
            vm.lea(VReg.V0, slot);
            vm.load(VReg.RET, VReg.V0, 0);
            vm.label(slot + "_done");
            vm.epilogue([VReg.S0, VReg.S1], 0);
        }
    }

    // Real %GeneratorFunction.prototype% / %AsyncFunction.prototype% tag
    // objects. Their @@toStringTag properties are configurable and therefore
    // must be stored state, not a hard-coded result in toString. Small
    // constructor singletons expose those prototypes for fn.constructor.prototype.
    generateFunctionKindTagProtos() {
        const vm = this.vm;
        // The eval shim is only linked for programs which actually invoke a
        // dynamic function constructor.  Its module initialiser installs the
        // three AOT maker closures into rooted runtime slots.
        vm.label("_dynamic_fn_maker_set");
        vm.lea(VReg.V0, "_dynamic_gen_maker"); vm.store(VReg.V0, 0, VReg.A0);
        vm.lea(VReg.V0, "_dynamic_async_maker"); vm.store(VReg.V0, 0, VReg.A1);
        vm.lea(VReg.V0, "_dynamic_asyncgen_maker"); vm.store(VReg.V0, 0, VReg.A2);
        vm.lea(VReg.RET, "_js_undefined"); vm.load(VReg.RET, VReg.RET, 0);
        vm.ret();

        const emitDynamicCtorCall = (label, slot) => {
            vm.label(label);
            vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
            // Snapshot the constructor's source arguments before any helper
            // call clobbers A0/RAX. `_fn_construct_call` uses the same
            // ordinary-function A0..A4 convention for [[Call]] and
            // [[Construct]]; `_call_argv` holds arguments 5..15.
            vm.store(VReg.SP, 0, VReg.A0);
            vm.store(VReg.SP, 8, VReg.A1);
            vm.store(VReg.SP, 16, VReg.A2);
            vm.store(VReg.SP, 24, VReg.A3);
            vm.store(VReg.SP, 32, VReg.A4);
            vm.lea(VReg.V0, "_call_argc"); vm.load(VReg.S4, VReg.V0, 0);
            vm.lea(VReg.V0, "_call_new_target"); vm.load(VReg.S2, VReg.V0, 0);
            // Build the actual CreateDynamicFunction argument list.
            vm.mov(VReg.A0, VReg.S4); vm.call("_array_new_with_size");
            vm.mov(VReg.S5, VReg.RET); // raw array
            for (let i = 0; i < 16; i++) {
                const skip = label + "_arg_skip_" + i;
                vm.cmpImm(VReg.S4, i); vm.jle(skip);
                if (i < 5) {
                    vm.load(VReg.A2, VReg.SP, i * 8);
                } else {
                    vm.lea(VReg.V0, "_call_argv");
                    vm.load(VReg.A2, VReg.V0, i * 8);
                }
                vm.mov(VReg.A0, VReg.S5); vm.movImm(VReg.A1, i);
                vm.call("_array_set");
                vm.label(skip);
            }
            vm.mov(VReg.A0, VReg.S5); vm.call("_box_arr_r");
            vm.mov(VReg.S3, VReg.RET); // boxed args array
            vm.lea(VReg.V0, slot); vm.load(VReg.S0, VReg.V0, 0);
            vm.cmpImm(VReg.S0, 0); vm.jeq(label + "_missing");
            vm.emitMaskLoad(VReg.V1); vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
            vm.load(VReg.S1, VReg.S0, 8);
            // Maker ABI: (kind, argumentList, NewTarget), ordinary non-strict this.
            const kind = slot.indexOf("asyncgen") >= 0 ? 3 :
                (slot.indexOf("async") >= 0 ? 2 : 1);
            vm.lea(VReg.V0, "_global_this"); vm.load(VReg.A0, VReg.V0, 0);
            vm.call("_box_obj_r"); vm.mov(VReg.A5, VReg.RET);
            vm.movImm(VReg.A0, kind); vm.scvtf(0, VReg.A0); vm.fmovToInt(VReg.A0, 0);
            vm.mov(VReg.A1, VReg.S3);
            vm.mov(VReg.A2, VReg.S2);
            vm.lea(VReg.A3, "_js_undefined"); vm.load(VReg.A3, VReg.A3, 0);
            vm.mov(VReg.A4, VReg.A3);
            vm.lea(VReg.V0, "_call_argc"); vm.movImm(VReg.V1, 3); vm.store(VReg.V0, 0, VReg.V1);
            vm.lea(VReg.V0, "_call_new_target"); vm.lea(VReg.V1, "_js_undefined"); vm.load(VReg.V1, VReg.V1, 0); vm.store(VReg.V0, 0, VReg.V1);
            vm.callIndirect(VReg.S1);
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);
            vm.label(label + "_missing");
            vm.call("_throw_not_a_function");
        };
        emitDynamicCtorCall("_dynamic_gen_ctor_call", "_dynamic_gen_maker");
        emitDynamicCtorCall("_dynamic_async_ctor_call", "_dynamic_async_maker");
        emitDynamicCtorCall("_dynamic_asyncgen_ctor_call", "_dynamic_asyncgen_maker");

        // Register one mmap-backed function in the host metadata universe.
        // Nodes deliberately start with the static table's 32-byte layout;
        // next@32 and the optional exact [[Prototype]]@40 are dynamic-only.
        vm.label("_dynamic_fn_meta_add");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // boxed function
        vm.mov(VReg.S1, VReg.A1); // full kind bits (brand/strict/nonctor)
        vm.mov(VReg.S2, VReg.A2); // canonical arity
        vm.mov(VReg.V3, VReg.A3); // raw persistent name string
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.load(VReg.S3, VReg.V0, 8); // mmap code pointer
        vm.push(VReg.S0); vm.push(VReg.V3);
        vm.movImm(VReg.A0, 48); vm.call("_alloc");
        vm.mov(VReg.V2, VReg.RET);
        vm.pop(VReg.V3); vm.pop(VReg.S0);
        vm.store(VReg.V2, 0, VReg.S3);
        vm.store(VReg.V2, 8, VReg.S1);
        vm.store(VReg.V2, 16, VReg.V3);
        vm.store(VReg.V2, 24, VReg.S2);
        vm.lea(VReg.V0, "_dynamic_func_meta_root");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.V2, 32, VReg.V1);
        vm.movImm(VReg.V1, 0); vm.store(VReg.V2, 40, VReg.V1);
        vm.store(VReg.V0, 0, VReg.V2);
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // Persist GetPrototypeFromConstructor for one mmap-backed function.
        // A0 is the boxed function and A1 the exact boxed prototype object.
        vm.label("_dynamic_fn_meta_set_proto");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.emitMaskLoad(VReg.V1); vm.andMaskReg(VReg.S2, VReg.S0, VReg.V1);
        vm.load(VReg.V0, VReg.S2, 0);
        vm.cmpImm(VReg.V0, 0xc105); vm.jeq("_dfmsp_closure");
        vm.cmpImm(VReg.V0, 0xa51c); vm.jeq("_dfmsp_closure");
        vm.jmp("_dfmsp_code_ready");
        vm.label("_dfmsp_closure");
        vm.load(VReg.S2, VReg.S2, 8);
        vm.label("_dfmsp_code_ready");
        vm.lea(VReg.V0, "_dynamic_func_meta_root"); vm.load(VReg.V0, VReg.V0, 0);
        vm.label("_dfmsp_loop");
        vm.cmpImm(VReg.V0, 0); vm.jeq("_dfmsp_done");
        vm.load(VReg.V1, VReg.V0, 0); vm.cmp(VReg.V1, VReg.S2); vm.jeq("_dfmsp_hit");
        vm.load(VReg.V0, VReg.V0, 32); vm.jmp("_dfmsp_loop");
        vm.label("_dfmsp_hit");
        // Generic Get(classInfo, "prototype") currently yields the raw
        // TYPE_OBJECT payload, while a direct Class.prototype expression is
        // canonical 0x7FFD.  Store the canonical object value so SameValue and
        // instanceof observe one identity across both access paths.
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0); vm.jne("_dfmsp_store");
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT); vm.jne("_dfmsp_store");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n); vm.or(VReg.S1, VReg.S1, VReg.V1);
        vm.label("_dfmsp_store");
        vm.store(VReg.V0, 40, VReg.S1);
        vm.label("_dfmsp_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // A0=code pointer -> the dynamic function's exact boxed [[Prototype]],
        // or 0 when it should use the intrinsic kind fallback.
        vm.label("_dynamic_fn_meta_proto");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.V0, "_dynamic_func_meta_root"); vm.load(VReg.V0, VReg.V0, 0);
        vm.label("_dfmp_loop");
        vm.cmpImm(VReg.V0, 0); vm.jeq("_dfmp_none");
        vm.load(VReg.V1, VReg.V0, 0); vm.cmp(VReg.V1, VReg.S0); vm.jeq("_dfmp_hit");
        vm.load(VReg.V0, VReg.V0, 32); vm.jmp("_dfmp_loop");
        vm.label("_dfmp_hit");
        vm.load(VReg.RET, VReg.V0, 40);
        vm.epilogue([VReg.S0], 0);
        vm.label("_dfmp_none");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);

        // Runtime fallback for %Function% when a specialised constructor's
        // [[Prototype]] is queried before a source-level `Function` identifier
        // has materialised the compiler-side singleton.
        vm.label("_function_empty_runtime");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.ret();

        vm.label("_function_ctor_runtime_call");
        vm.prologue(0, [VReg.S0]);
        vm.movImm(VReg.A0, 16); vm.call("_alloc"); vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105); vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_function_empty_runtime"); vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S0); vm.call("_js_box_function");
        vm.epilogue([VReg.S0], 0);

        vm.label("_ensure_function_ctor_runtime");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.lea(VReg.V0, "_fnctor_singleton"); vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0); vm.jne("_ensure_function_ctor_runtime_done");
        vm.call("_ensure_function_proto"); vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, 16); vm.call("_alloc"); vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105); vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_function_ctor_runtime_call"); vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S0); vm.call("_js_box_function"); vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V0, "_fnctor_singleton"); vm.store(VReg.V0, 0, VReg.S0);
        for (const [name, emitValue] of [
            ["name", () => {
                vm.lea(VReg.A2, vm.asm.addString("Function"));
                vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V1);
            }],
            ["length", () => {
                vm.movImm(VReg.A2, 1); vm.scvtf(0, VReg.A2); vm.fmovToInt(VReg.A2, 0);
            }],
        ]) {
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString(name));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            emitValue(); vm.call("_closure_prop_set");
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString(name));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, 4); vm.call("_closure_prop_set_attr");
        }
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S1); vm.call("_closure_prop_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 0); vm.call("_closure_prop_set_attr");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0); vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 5); vm.call("_object_set_prop_attr");
        vm.label("_ensure_function_ctor_runtime_done");
        vm.lea(VReg.V0, "_fnctor_singleton"); vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        const specs = [
            ["genfunc", "_nsobj_genfunc_proto", "GeneratorFunction"],
            ["asyncfunc", "_nsobj_asyncfunc_proto", "AsyncFunction"],
        ];
        for (const [pfx, protoSlot, tag] of specs) {
            const ready = `_opts_${pfx}_tag_ready`;
            const ctor = `_opts_${pfx}_ctor`;
            vm.asm.addDataLabel(ready); vm.asm.addDataQword(0);
            vm.asm.addDataLabel(ctor); vm.asm.addDataQword(0);
            vm.label(`_ensure_${pfx}_tag_proto`);
            vm.prologue(0, [VReg.S0, VReg.S1]);
            vm.lea(VReg.V0, protoSlot);
            vm.load(VReg.S0, VReg.V0, 0);
            vm.cmpImm(VReg.S0, 0);
            vm.jne(`_ensure_${pfx}_proto_have`);
            vm.call("_object_new");
            vm.call("_box_obj_r");
            vm.mov(VReg.S0, VReg.RET);
            // %GeneratorFunction.prototype% and %AsyncFunction.prototype%
            // inherit from %Function.prototype% (they are non-callable ordinary
            // intrinsic objects in the observable test262 surface).
            vm.call("_ensure_function_proto");
            vm.mov(VReg.S1, VReg.RET);
            vm.emitMaskLoad(VReg.V1);
            vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
            vm.andMaskReg(VReg.V1, VReg.S1, VReg.V1);
            vm.store(VReg.V0, 16, VReg.V1);
            vm.lea(VReg.V0, protoSlot); vm.store(VReg.V0, 0, VReg.S0);
            vm.label(`_ensure_${pfx}_proto_have`);
            vm.lea(VReg.V0, ready); vm.load(VReg.V1, VReg.V0, 0);
            vm.cmpImm(VReg.V1, 0); vm.jne(`_ensure_${pfx}_proto_done`);
            vm.lea(VReg.A0, "_symwk_toStringTag");
            vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
            vm.call("_symbol_wellknown");
            vm.mov(VReg.S1, VReg.RET);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1);
            vm.lea(VReg.A2, vm.asm.addString(tag));
            vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V0);
            vm.call("_object_define");
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.movImm(VReg.A2, 4);
            vm.call("_object_set_prop_attr");
            vm.lea(VReg.V0, ready); vm.movImm(VReg.V1, 1); vm.store(VReg.V0, 0, VReg.V1);
            vm.label(`_ensure_${pfx}_proto_done`);
            vm.mov(VReg.RET, VReg.S0);
            vm.epilogue([VReg.S0, VReg.S1], 0);

            vm.label(`_ensure_${pfx}_ctor`);
            vm.prologue(0, [VReg.S0, VReg.S1]);
            vm.lea(VReg.V0, ctor); vm.load(VReg.RET, VReg.V0, 0);
            vm.cmpImm(VReg.RET, 0); vm.jne(`_ensure_${pfx}_ctor_done`);
            vm.call(`_ensure_${pfx}_tag_proto`);
            vm.mov(VReg.S1, VReg.RET);
            vm.movImm(VReg.A0, 16); vm.call("_alloc"); vm.mov(VReg.S0, VReg.RET);
            vm.movImm(VReg.V1, 0xc105); vm.store(VReg.S0, 0, VReg.V1);
            vm.lea(VReg.V1, pfx === "genfunc"
                ? "_dynamic_gen_ctor_call" : "_dynamic_async_ctor_call");
            vm.store(VReg.S0, 8, VReg.V1);
            vm.mov(VReg.A0, VReg.S0); vm.call("_js_box_function"); vm.mov(VReg.S0, VReg.RET);
            vm.lea(VReg.V0, ctor); vm.store(VReg.V0, 0, VReg.S0);
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString("name"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.lea(VReg.A2, vm.asm.addString(tag));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V1);
            vm.call("_closure_prop_set");
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString("name"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, 4); vm.call("_closure_prop_set_attr");
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString("length"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, 1); vm.scvtf(0, VReg.A2); vm.fmovToInt(VReg.A2, 0);
            vm.call("_closure_prop_set");
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString("length"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, 4); vm.call("_closure_prop_set_attr");
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString("prototype"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.mov(VReg.A2, VReg.S1); vm.call("_closure_prop_set");
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString("prototype"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, 0); vm.call("_closure_prop_set_attr");
            // intrinsicProto.constructor = intrinsic constructor,
            // { writable:false, enumerable:false, configurable:true }.
            vm.mov(VReg.A0, VReg.S1);
            vm.lea(VReg.A1, vm.asm.addString("constructor"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.mov(VReg.A2, VReg.S0); vm.call("_object_define");
            vm.mov(VReg.A0, VReg.S1);
            vm.lea(VReg.A1, vm.asm.addString("constructor"));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, 4); vm.call("_object_set_prop_attr");
            if (pfx === "genfunc") {
                // %GeneratorFunction.prototype%.prototype =
                // %GeneratorPrototype%, with the same configurable-only shape.
                vm.call("_ensure_gen_proto");
                vm.mov(VReg.A2, VReg.RET);
                vm.mov(VReg.A0, VReg.S1);
                vm.lea(VReg.A1, vm.asm.addString("prototype"));
                vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
                vm.call("_object_define");
                vm.mov(VReg.A0, VReg.S1);
                vm.lea(VReg.A1, vm.asm.addString("prototype"));
                vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
                vm.movImm(VReg.A2, 4); vm.call("_object_set_prop_attr");
            }
            vm.label(`_ensure_${pfx}_ctor_done`);
            vm.lea(VReg.V0, ctor); vm.load(VReg.RET, VReg.V0, 0);
            vm.epilogue([VReg.S0, VReg.S1], 0);
        }

        vm.asm.addDataLabel("_opts_asyncgenfunc_tag_ready"); vm.asm.addDataQword(0);
        vm.label("_ensure_asyncgenfunc_tag_proto");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.call("_ensure_asyncgenfunc");
        vm.lea(VReg.V0, "_nsobj_asyncgenfunc_proto"); vm.load(VReg.S0, VReg.V0, 0);
        vm.lea(VReg.V0, "_opts_asyncgenfunc_tag_ready"); vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0); vm.jne("_ensure_asyncgenfunc_tag_done");
        vm.lea(VReg.A0, "_symwk_toStringTag");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown"); vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1);
        vm.lea(VReg.A2, vm.asm.addString("AsyncGeneratorFunction"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A2, VReg.A2, VReg.V0);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.movImm(VReg.A2, 4);
        vm.call("_object_set_prop_attr");
        vm.lea(VReg.V0, "_opts_asyncgenfunc_tag_ready"); vm.movImm(VReg.V1, 1); vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_ensure_asyncgenfunc_tag_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Object.prototype.toString.call(x) -> "[object Tag]"。规范:先 Get(@@toStringTag),
    // 字符串用之;否则 builtinTag(Array/Function/Error/…/Object)。Map/Set/Promise 等无
    // 独立 builtinTag——品牌仅来自可配置的原型 @@toStringTag;delete 后应回落 "Object"。
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
        // IsArray must precede Get(@@toStringTag) for Proxies. A get trap may
        // revoke the proxy, and the already-completed IsArray result remains
        // usable (proxy-revoked-during-get-call).
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jne("_opts_early_tag");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V0, VReg.V1, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY); vm.jeq("_opts_classify");
        vm.label("_opts_early_tag");
        // All non-nullish values consult @@toStringTag before builtin fallback.
        // Remember a present non-undefined non-string value so simulated
        // tag-only brands (notably Generator) can correctly fall back to Object.
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get_tostring_tag");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_opts_custom");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_opts_classify");
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.label("_opts_classify");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_opts_arrayish");
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
            vm.cmpImm(VReg.RET, 0); vm.jne("_opts_symbol_check");
            // ES Object.prototype.toString:ToObject 后先 IsArray。revoked proxy
            // 的 IsArray 抛 TypeError(handler 空);proxy-of-Array → Array 品牌。
            // 裸堆指针(high16=0)先 0x7FFD 装箱,否则 _is_array_value 不认 TYPE_PROXY。
            vm.mov(VReg.A0, VReg.S0);
            vm.shrImm(VReg.V0, VReg.S0, 48);
            vm.cmpImm(VReg.V0, 0);
            vm.jne("_opts_isarr");
            vm.movImm64(VReg.V1, 0x7ffd000000000000n);
            vm.or(VReg.A0, VReg.S0, VReg.V1);
            vm.label("_opts_isarr");
            vm.call("_is_array_value");
            vm.cmpImm(VReg.RET, 0); vm.jne("_opts_arrayish");
            // 其余非属性堆对象按类型字节([S1+0])短路。
            vm.loadByte(VReg.V0, VReg.S1, 0);
            vm.andImm(VReg.V0, VReg.V0, 0xff);
            vm.cmpImm(VReg.V0, 8); vm.jeq("_opts_proxy");       // TYPE_PROXY
            vm.cmpImm(VReg.V0, 7); vm.jeq("_opts_date");        // TYPE_DATE
            vm.cmpImm(VReg.V0, 11); vm.jeq("_opts_promise_check"); // TYPE_PROMISE
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
            vm.cmpImm(VReg.RET, 0); vm.jne("_opts_asyncgenerator_check");
            vm.jmp("_opts_generator_check");
            vm.label("_opts_notgen");
        }
        vm.jmp("_opts_tag");
        // callable proxy → Function 品牌;非 callable 与旧行为一致走 Object。
        // revoked 已在上方 IsArray 抛出,不落到此。
        vm.label("_opts_proxy");
        // IsArray has completed; now perform the single observable Get.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get_tostring_tag");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_opts_custom");
        vm.label("_opts_proxy_unwrap");
        vm.load(VReg.S0, VReg.S1, 8); // target (becomes the function value for metadata)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V2, VReg.V1); vm.jlt("_opts_proxy_callable");
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY); vm.jne("_opts_proxy_callable");
        vm.mov(VReg.S1, VReg.V2);
        vm.jmp("_opts_proxy_unwrap");
        vm.label("_opts_proxy_callable");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_callable");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_opts_plain");
        // Proxy callable builtinTag is Function, but a string @@toStringTag
        // inherited by the ultimate target (GeneratorFunction/AsyncFunction)
        // still overrides it. Once that tag is deleted or made non-string,
        // fall back to Function rather than the target's internal kind.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get_tostring_tag");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_opts_custom");
        vm.jmp("_opts_proxy_function");
        ret("_opts_proxy_function", "[object Function]");
        vm.label("_opts_tag");
        // [Symbol.toStringTag] 优先(字符串则 "[object <tag>]")
        vm.lea(VReg.A0, "_symwk_toStringTag");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); // toStringTag 是字符串?
        vm.jeq("_opts_custom");
        // Map/Set 实例无 props 槽:_object_get 对 type 4/5 直接 miss,不会沿原型取
        // Set.prototype[@@toStringTag]。若对应原型单例已物化,改从原型 Get;字符串 →
        // custom;非字符串(含 delete 后)→ "Object"(规范 builtinTag,禁止再按 TYPE_SET
        // 字节强行 "Set")。原型尚未物化时保留内建品牌(new Set() 未触 Set.prototype
        // 的常见路径仍得 "[object Set]")。WeakMap/WeakSet 仍走 weakness 品牌。
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 4); vm.jeq("_opts_coll_map");
        vm.cmpImm(VReg.V0, 5); vm.jeq("_opts_coll_set");
        vm.jmp("_opts_builtin_rest");
        vm.label("_opts_coll_map");
        vm.load(VReg.V0, VReg.S1, 48); // weakness
        vm.cmpImm(VReg.V0, 0); vm.jne("_opts_coll_weakmap");
        vm.lea(VReg.V0, "_nsobj_map_proto");
        vm.jmp("_opts_coll_proto");
        vm.label("_opts_coll_weakmap");
        vm.lea(VReg.V0, "_nsobj_weakmap_proto");
        vm.jmp("_opts_coll_proto");
        vm.label("_opts_coll_set");
        vm.load(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0); vm.jne("_opts_coll_weakset");
        vm.lea(VReg.V0, "_nsobj_set_proto");
        vm.jmp("_opts_coll_proto");
        vm.label("_opts_coll_weakset");
        vm.lea(VReg.V0, "_nsobj_weakset_proto");
        vm.label("_opts_coll_proto");
        vm.load(VReg.A0, VReg.V0, 0); // 原型单例(0=未物化)
        vm.cmpImm(VReg.A0, 0); vm.jeq("_opts_coll_brand"); // 未物化 → 内建 Map/Set
        // 已物化:Get(proto, @@toStringTag);非字符串 → Object(不回落 TYPE_* 品牌)
        vm.mov(VReg.S2, VReg.A0); // S2 暂存 proto(跨 wellknown call)
        vm.lea(VReg.A0, "_symwk_toStringTag");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.toStringTag"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_opts_custom");
        vm.jmp("_opts_plain"); // delete/非 string tag → Object
        // 原型未物化:按 type 字节内建品牌(与历史 toString.call(new Set()) 对齐)
        vm.label("_opts_coll_brand");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 4); vm.jeq("_opts_maybe_weakmap");
        vm.jmp("_opts_maybe_weakset");
        vm.label("_opts_builtin_rest");
        // 其余内建品牌:按类型字节 / 标志
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 7); vm.jeq("_opts_date");   // TYPE_DATE([[DateValue]])
        vm.cmpImm(VReg.V0, TYPE_OBJECT); vm.jne("_opts_not_wrapper");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__boolean_value"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0); vm.jne("_opts_bool");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0); vm.jne("_opts_number");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.movImm64(VReg.V0, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0); vm.jne("_opts_string");
        vm.label("_opts_not_wrapper");
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
        vm.mov(VReg.A0, VReg.RET);         // 先取走 s1(x64 V0≡RET:下方 mask/tag 写 V0 会盖掉)
        vm.lea(VReg.A1, vm.asm.addString("]"));
        vm.movImm64(VReg.V0, 0x0000ffffffffffffn);
        vm.and(VReg.A1, VReg.A1, VReg.V0);
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V0);
        vm.call("_strconcat");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        ret("_opts_undef", "[object Undefined]");
        ret("_opts_null", "[object Null]");
        // 0x7FFE 兼 Array / Arguments(byte1 ARR_IS_ARGUMENTS)。IsArray(arguments)
        // 为假,builtinTag 是 Arguments(every/filter *-1-15)。
        vm.label("_opts_arrayish");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_opts_arguments");
        vm.jmp("_opts_array");
        ret("_opts_array", "[object Array]");
        ret("_opts_arguments", "[object Arguments]");
        ret("_opts_string", "[object String]");
        ret("_opts_bool", "[object Boolean]");
        vm.label("_opts_symbol_check");
        vm.lea(VReg.V0, "_nsobj_symbol_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0); vm.jne("_opts_plain");
        vm.jmp("_opts_symbol");
        vm.label("_opts_promise_check");
        vm.lea(VReg.V0, "_nsobj_promise_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0); vm.jne("_opts_plain");
        vm.jmp("_opts_promise");
        vm.label("_opts_generator_check");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 0); vm.jne("_opts_plain");
        vm.jmp("_opts_generator");
        vm.label("_opts_asyncgenerator_check");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmpImm(VReg.V0, 0); vm.jne("_opts_plain");
        vm.jmp("_opts_asyncgenerator");
        // The early Get(@@toStringTag) above supplies the specialised
        // Generator/Async brands.  If that property was deleted or changed to
        // a non-string value, the callable builtin fallback is always Function.
        vm.label("_opts_func");
        vm.lea(VReg.A0, vm.asm.addString("[object Function]"));
        vm.call("_cstr_to_heap_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
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

    // ES 19.1.3.5: Object.prototype.toLocaleString → Invoke(this, "toString").
    // Get 经 ToObject(this) 走原型链;Call 的 thisArg 保持原 this(严格模式原语保持原语)。
    generateObjectProtoToLocaleString() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_object_proto_toLocaleString");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // this (Call receiver)
        // ToObject(this) 仅供 Get;null/undefined → TypeError
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_otls_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_otls_nullish");
        vm.cmpImm(VReg.V0, 0x7FF9);
        vm.jeq("_otls_bool");
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_otls_str");
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jeq("_otls_num");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_otls_id");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_otls_id");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_otls_id");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_otls_hip0");
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_otls_num");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jgt("_otls_num");
        vm.jmp("_otls_id");
        vm.label("_otls_hip0");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_otls_num");
        vm.jmp("_otls_id");
        vm.label("_otls_bool");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_boolean_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_otls_get");
        vm.label("_otls_num");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_otls_get");
        vm.label("_otls_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_string_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_otls_get");
        vm.label("_otls_id");
        vm.mov(VReg.S1, VReg.S0);
        vm.label("_otls_get");
        // Get(O, "toString") — 须解访问器。Boolean.prototype.toString 被 defineProperty
        // 成 getter 时,裸标记块当函数 callIndirect → SIGBUS
        // (Array.prototype.toLocaleString primitive_this_value_getter)。
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("toString"));
        boxStr(VReg.A1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        // Call(fn, this=S0, []) — thisArg 保持原值(严格模式原语不装箱)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_spread_call0");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_otls_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // Object.getOwnPropertySymbols(obj) -> 仅 symbol 键数组(_object_keys 的反面:
    // 只收 symbol 键;可枚举与否不影响 symbol 键的收集)。
    generateObjectGetOwnPropertySymbols() {
        const vm = this.vm;
        vm.label("_object_getOwnPropertySymbols");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        // Type check: null/undefined → TypeError (ToObject step)
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_ogops_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_ogops_nullish");
        // Plain objects keep keys inline. Arrays/functions cannot use the plain
        // object layout; their named and Symbol properties live in the shared
        // _closure_props_* side table, so enumerate that backing object below.
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_ogops_obj");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_ogops_side");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_ogops_side");
        vm.cmpImm(VReg.V0, 0);      vm.jeq("_ogops_obj"); // bare pointer
        // Anything else → return empty array
        vm.label("_ogops_empty");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        vm.label("_ogops_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // does not return

        vm.label("_ogops_side");
        // Symbol assignment and DefineOwnProperty both use this side table.
        // Reusing the ordinary-object scan preserves the original creation
        // order when defineProperty later changes an existing descriptor.
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ogops_empty");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_getOwnPropertySymbols");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        vm.label("_ogops_obj");
        vm.mov(VReg.S0, VReg.A0);
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);
        // high16==0 is shared by raw heap pointers, +0 and denormal Numbers.
        // Do not dereference numeric payloads while performing ToObject; all
        // primitive wrappers have no own Symbol keys and therefore return [].
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_ogops_empty");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_ogops_empty");
        // Proxy [[OwnPropertyKeys]] must run (and validate) even when the final
        // Symbol-only filter would produce an empty list.  In particular,
        // duplicate/missing *string* keys can still violate the ownKeys trap
        // invariants observed by Object.getOwnPropertySymbols.
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jeq("_ogops_proxy");
        // Only TYPE_OBJECT has count/props_ptr at expected offsets.
        // Date/Map/Set/etc. have different layouts.
        vm.cmpImm(VReg.V0, TYPE_OBJECT);
        vm.jne("_ogops_empty");
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
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_ogops_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ogops_loop");
        vm.label("_ogops_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        vm.label("_ogops_proxy");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_own_keys_all"); // invokes/validates ownKeys; returns a fresh list
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.S4, 0);
        vm.label("_ogops_proxy_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_ogops_proxy_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogops_proxy_next");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_ogops_proxy_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_ogops_proxy_loop");
        vm.label("_ogops_proxy_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.S2, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // Complete own-key snapshot after Object-style ToObject coercion.  The
    // low-level _object_own_keys_all walker is sufficient for ordinary objects
    // and Proxy trap results, but indexed exotics synthesize string keys such
    // as "length" while keeping Symbols in a side table.  Merge the two public
    // reflection views for non-Proxies; a Proxy must use one validated trap
    // invocation, never independent names/symbols queries.
    generateObjectAllOwnKeys() {
        const vm = this.vm;
        const hiddenRegExpKeys = [
            "source", "flags", "global", "ignoreCase", "multiline", "dotAll",
            "sticky", "unicode", "unicodeSets", "hasIndices",
            "__isRegExp", "__pat", "__prog", "__bad", "__err",
        ];

        vm.label("_object_all_own_keys");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // original boxed/raw receiver
        vm.movImm(VReg.S5, 0);    // RegExp shim brand

        // A Proxy has to take the single [[OwnPropertyKeys]] route.  Guard raw
        // numeric payloads before reading a heap type byte.
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_oaok_heap");
        vm.cmpImm(VReg.V0, 0); vm.jne("_oaok_collect");
        vm.cmpImm(VReg.S0, 0); vm.jeq("_oaok_collect");
        vm.label("_oaok_heap");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_oaok_collect");
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jeq("_oaok_proxy");
        // RegExp is represented by a branded ordinary shim object.  Its engine
        // state and emulated prototype accessors are storage slots, not ECMAScript
        // own properties; retain only lastIndex and user-created keys.
        vm.cmpImm(VReg.V0, TYPE_OBJECT);
        vm.jne("_oaok_collect");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__isRegExp"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.mov(VReg.S5, VReg.RET);

        vm.label("_oaok_collect");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_gopn");
        vm.mov(VReg.S1, VReg.RET); // string keys, including indexed-exotic length
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_getOwnPropertySymbols");
        vm.mov(VReg.S2, VReg.RET); // symbol keys
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S3, VReg.RET); // raw result

        vm.movImm(VReg.S4, 0);
        vm.label("_oaok_str_loop");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.cmp(VReg.S4, VReg.RET);
        vm.jge("_oaok_sym_begin");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_oaok_str_push");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_oaok_str_push");
        for (const name of hiddenRegExpKeys) {
            vm.load(VReg.A0, VReg.SP, 0);
            vm.call("_getStrContent");
            vm.mov(VReg.A0, VReg.RET);
            vm.lea(VReg.A1, vm.asm.addString(name));
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq("_oaok_str_next");
        }
        vm.label("_oaok_str_push");
        vm.mov(VReg.A0, VReg.S3);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_array_push_own");
        vm.mov(VReg.S3, VReg.RET);
        vm.label("_oaok_str_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_oaok_str_loop");

        vm.label("_oaok_sym_begin");
        vm.movImm(VReg.S4, 0);
        vm.label("_oaok_sym_loop");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_length");
        vm.cmp(VReg.S4, VReg.RET);
        vm.jge("_oaok_done");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_push_own");
        vm.mov(VReg.S3, VReg.RET);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_oaok_sym_loop");

        vm.label("_oaok_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.or(VReg.RET, VReg.S3, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        vm.label("_oaok_proxy");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_own_keys_all");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // Reflect.ownKeys differs only in rejecting primitives before the same
        // complete snapshot operation.
        vm.label("_reflect_ownKeys");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD); vm.jeq("_row_ok");
        vm.cmpImm(VReg.V1, 0x7FFE); vm.jeq("_row_ok");
        vm.cmpImm(VReg.V1, 0x7FFF); vm.jeq("_row_ok");
        vm.cmpImm(VReg.V1, 0); vm.jne("_row_bad");
        vm.cmpImm(VReg.S0, 0); vm.jeq("_row_bad");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0); vm.jne("_row_bad");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jne("_row_bad");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1); vm.jlt("_row_bad");
        vm.label("_row_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_all_own_keys");
        vm.epilogue([VReg.S0], 0);
        vm.label("_row_bad");
        vm.lea(VReg.A0, vm.asm.addString("Reflect.ownKeys called on non-object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    // Object.getOwnPropertyDescriptors(O): take one complete key snapshot,
    // re-read each current own descriptor, and create a data property on the
    // result.  Proxy getOwnPropertyDescriptor may report undefined for a key,
    // in which case that key is omitted.
    generateObjectGetOwnPropertyDescriptors() {
        const vm = this.vm;
        vm.label("_object_getOwnPropertyDescriptors");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // receiver
        vm.call("_object_all_own_keys");
        vm.mov(VReg.S1, VReg.RET); // boxed snapshot
        vm.call("_object_new");
        vm.mov(VReg.S2, VReg.RET); // raw result ordinary object
        vm.movImm(VReg.S3, 0);
        vm.label("_ogopds_loop");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.cmp(VReg.S3, VReg.RET);
        vm.jge("_ogopds_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET); // key
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.mov(VReg.S5, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S5, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_ogopds_next");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_object_define"); // CreateDataProperty(result, key, descriptor)
        vm.label("_ogopds_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ogopds_loop");
        vm.label("_ogopds_done");
        vm.movImm64(VReg.V1, 0x7FFD000000000000n);
        vm.or(VReg.RET, VReg.S2, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
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
        // Function values use the same generic descriptor-driven algorithm:
        // name/length are normally non-enumerable, but defineProperty can make
        // them enumerable and Object.values must observe that transition.
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_values_legacy");
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_values_empty");
        vm.cmpImm(VReg.A0, 0); vm.jeq("_object_values_empty");
        vm.label("_object_values_legacy");

        // EnumerableOwnProperties must snapshot [[OwnPropertyKeys]], then for
        // each string key re-read the *current* own descriptor and finally Get
        // the value.  The old loop walked the live props array by index and
        // loaded its raw value slot: accessors leaked their marker pointer as a
        // denormal Number, deletion shifted future entries, enumerability
        // changes were ignored, and Proxy traps were bypassed by forwarding to
        // the target.  Route ordinary objects and proxies through the generic
        // snapshot algorithm below.
        vm.jmp("_object_values_generic");

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

        // [W-47] 过滤 mangled 私有键 `#Class#field`(同 _object_keys_loop)
        // V0 被 _is_symbol clobber,需重算 propAddr
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_values_push");
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_mangled_private_name");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_values_next");

        vm.label("_object_values_push");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push_own");
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

        vm.label("_object_values_generic");
        vm.mov(VReg.S0, VReg.A0); // original receiver (boxed/raw)
        vm.call("_object_gopn");  // snapshot of own string keys / Proxy ownKeys
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET); // raw result array
        vm.movImm(VReg.S3, 0);
        vm.label("_object_values_generic_loop");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.cmp(VReg.S3, VReg.RET);
        vm.jge("_object_values_generic_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET); // key
        // Internal private names are not ECMAScript properties.
        vm.shrImm(VReg.V1, VReg.S4, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_object_values_generic_desc");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_mangled_private_name");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_values_generic_next");
        vm.label("_object_values_generic_desc");
        // desc = O.[[GetOwnProperty]](key), observable for Proxy.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.shrImm(VReg.V1, VReg.RET, 48); // preserve RET on x64 (V0 aliases it)
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_object_values_generic_next");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("enumerable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_values_generic_next");
        // value = Get(O, key), including accessor invocation / abrupt completion.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_values_generic_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_values_generic_loop");
        vm.label("_object_values_generic_done");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.S2, VReg.V1);
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
        vm.call("_array_push_own");
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
        vm.call("_array_push_own");
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

        // [W-16] 函数接收者(0x7FFF):函数不是 plain 属性容器,按对象头读 count@8/props_ptr@32
        // 会解引用垃圾 → SIGSEGV。自有属性在 _closure_props_* 侧表 → 枚举侧表 props 对象;
        // 侧表 miss → 空数组。详注见 _object_keys_fn。走 _object_entries(props) 再取 v,
        // 是为了能按键名滤掉 length/name/prototype(node 里它们 enumerable:false),
        // 与 Object.keys(fn) 严格同集合(否则 keys().length !== values().length)。
        vm.label("_object_values_fn");
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_values_empty");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_entries");      // RET = 装箱 [[k,v],...]
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET);       // len
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);       // 裸结果数组
        vm.movImm(VReg.S3, 0);           // i
        vm.label("_object_values_fn_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_values_fn_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET);       // pair = [k, v]
        vm.mov(VReg.A0, VReg.S4);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_get");           // key
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_values_fn_take"); // 非字符串键:直接收下
        for (const nm of ["length", "name", "prototype"]) {
            vm.mov(VReg.A0, VReg.S4);
            vm.movImm(VReg.A1, 0);
            vm.call("_array_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_getStrContent");
            vm.mov(VReg.A0, VReg.RET);
            vm.lea(VReg.A1, vm.asm.addString(nm));
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq("_object_values_fn_next");
        }
        vm.label("_object_values_fn_take");
        vm.mov(VReg.A0, VReg.S4);
        vm.movImm(VReg.A1, 1);
        vm.call("_array_get");           // value
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_values_fn_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_values_fn_loop");
        vm.label("_object_values_fn_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
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

        // See `_object_values_generic`: entries uses the same key snapshot /
        // current-descriptor / live-Get algorithm and only differs in packaging
        // each accepted value as a fresh [key, value] pair.
        vm.jmp("_object_entries_generic");

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

        // [W-47] 过滤 mangled 私有键 `#Class#field`(同 _object_keys_loop)
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_entries_push");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_mangled_private_name");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_entries_next");

        vm.label("_object_entries_push");
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
        vm.call("_array_push_own");
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

        vm.label("_object_entries_generic");
        vm.mov(VReg.S0, VReg.A0); // original receiver
        vm.call("_object_gopn");
        vm.mov(VReg.S1, VReg.RET); // snapshotted string keys
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET); // raw result
        vm.movImm(VReg.S3, 0);
        vm.label("_object_entries_generic_loop");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.cmp(VReg.S3, VReg.RET);
        vm.jge("_object_entries_generic_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET); // key
        vm.shrImm(VReg.V1, VReg.S4, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_object_entries_generic_desc");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_mangled_private_name");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_object_entries_generic_next");
        vm.label("_object_entries_generic_desc");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_object_entries_generic_next");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("enumerable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_entries_generic_next");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S5, VReg.RET); // value
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_array_set");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.movImm(VReg.A1, 1);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_entries_generic_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_entries_generic_loop");
        vm.label("_object_entries_generic_done");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.S2, VReg.V1);
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
        vm.call("_array_push_own");
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
        vm.call("_array_push_own");
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

        // [W-16] 函数接收者(0x7FFF):函数不是 plain 属性容器,按对象头读 count@8/props_ptr@32
        // 会解引用垃圾 → SIGSEGV。自有属性在 _closure_props_* 侧表 → 枚举侧表 props 对象;
        // 侧表 miss → 空数组。详注见 _object_keys_fn。
        vm.label("_object_entries_fn");
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_object_entries_empty");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_entries");      // RET = 装箱 [[k,v],...]
        // 与 Object.keys(fn) 同集合:滤掉 length/name/prototype(node 里 enumerable:false)
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S1, VReg.RET);       // len
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);       // 裸结果数组
        vm.movImm(VReg.S3, 0);           // i
        vm.label("_object_entries_fn_loop");
        vm.cmp(VReg.S3, VReg.S1); vm.jge("_object_entries_fn_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET);       // pair
        vm.mov(VReg.A0, VReg.S4);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_get");           // key
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_object_entries_fn_take");
        for (const nm of ["length", "name", "prototype"]) {
            vm.mov(VReg.A0, VReg.S4);
            vm.movImm(VReg.A1, 0);
            vm.call("_array_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_getStrContent");
            vm.mov(VReg.A0, VReg.RET);
            vm.lea(VReg.A1, vm.asm.addString(nm));
            vm.call("_strcmp");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq("_object_entries_fn_next");
        }
        vm.label("_object_entries_fn_take");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_push_own");
        vm.mov(VReg.S2, VReg.RET);
        vm.label("_object_entries_fn_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_entries_fn_loop");
        vm.label("_object_entries_fn_done");
        vm.movImm64(VReg.V1, 0x7FFE000000000000n);
        vm.mov(VReg.RET, VReg.S2);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
    }

    // _string_new(A0 = boxed/raw string) -> boxed String wrapper (0x7FFD)
    // 对齐 compiler new String: __value + length + 字符索引自有属性(不可写) + String.prototype。
    // 供 Object.assign ToObject(string);字符索引 ATTR_ENUMERABLE-only → Set(Throw) 拒写。
    generateStringNew() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_string_new");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // primitive string
        vm.call("_ensure_string_proto"); // 保证 valueOf/toString 可链
        vm.call("_object_new");
        vm.mov(VReg.S1, VReg.RET); // raw wrapper
        // __proto__ = String.prototype
        vm.lea(VReg.V0, "_nsobj_string_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.S1, 16, VReg.V0);
        // __value
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("__value")); boxStr(VReg.A1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_define");
        // length
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_utf16_length");
        vm.mov(VReg.S2, VReg.RET); // ECMAScript UTF-16 code-unit length
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A2, 0);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("length")); boxStr(VReg.A1);
        vm.call("_object_define");
        // attrs: __value writable|configurable(5); length 全禁(0)
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.movImm(VReg.A2, ATTR_WRITABLE | ATTR_CONFIGURABLE);
        vm.call("_object_set_attr");
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.movImm(VReg.A2, 0);
        vm.call("_object_set_attr");
        // 字符索引: enumerable 自有、不可写不可配置(ES String exotic)
        vm.movImm(VReg.S3, 0);
        vm.label("_string_new_idx");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_string_new_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_utf16_at");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_valueToStr");
        vm.mov(VReg.A1, VReg.RET); // index key
        vm.load(VReg.A2, VReg.SP, 0); // UTF-16 code-unit string
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_define");
        // idx = 2 + i (__value=0, length=1)
        vm.mov(VReg.A0, VReg.S1);
        vm.addImm(VReg.A1, VReg.S3, 2);
        vm.movImm(VReg.A2, ATTR_ENUMERABLE); // writable:false configurable:false
        vm.call("_object_set_attr");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_string_new_idx");
        vm.label("_string_new_done");
        // _box_obj_r boxes RET, not A0. On x64 leftover RET is _object_set_attr
        // status → wrapper tagged 0x7FFD at a garbage/zero pointer (gOPN empty,
        // length≈-2^63, isExtensible=false).
        vm.mov(VReg.RET, VReg.S1);
        vm.call("_box_obj_r");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // Object.assign(target, ...sources) -> target
    // 简化版：_object_assign(target, source) -> target
    generateObjectAssign() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };

        vm.label("_object_assign");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        // ES 20.1.2.1: Let to be ? ToObject(target). null/undefined → TypeError;
        // string/number/bool → wrapper; object/array/fn/heap → 恒等。
        vm.mov(VReg.S1, VReg.A1); // source 先存(ToObject 可能毁 A1)
        vm.mov(VReg.S0, VReg.A0); // target
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_assign_nullish_tgt");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_assign_nullish_tgt");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_assign_tgt_ok");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_assign_tgt_ok");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_assign_tgt_ok");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_assign_tgt_str");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_object_assign_tgt_bool");
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_object_assign_tgt_num");
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_assign_tgt_num"); // float / NaN
        vm.cmpImm(VReg.S0, 0); vm.jeq("_object_assign_tgt_num"); // +0.0
        // high16==0 且非零通常是裸堆指针,但 primitive Symbol also uses
        // that representation and ToObject must create a Symbol wrapper.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_assign_tgt_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_symbol_wrap");
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_object_assign_tgt_ok");

        vm.label("_object_assign_tgt_str");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_string_new");
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_object_assign_tgt_ok");
        vm.label("_object_assign_tgt_bool");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_boolean_new");
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_object_assign_tgt_ok");
        vm.label("_object_assign_tgt_num");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_number_new");
        vm.mov(VReg.S0, VReg.RET);

        vm.label("_object_assign_tgt_ok");
        // source null/undefined/number/bool → 跳过(返 to);string/array → 索引拷;其余 legacy
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_assign_ret_tgt");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_assign_ret_tgt");
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_object_assign_ret_tgt");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_object_assign_ret_tgt");
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_assign_src_str");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_assign_src_arr");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_assign_legacy");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_assign_legacy");
        vm.cmpImm(VReg.V0, 0); vm.jne("_object_assign_ret_tgt"); // float source
        vm.cmpImm(VReg.S1, 0); vm.jeq("_object_assign_ret_tgt"); // +0.0
        // 裸堆指针 source → 原路径
        vm.label("_object_assign_legacy");

        // S0=boxed to; SP+8=boxed to; SP+16=boxed source(供 [[Get]] this / _maybe_getter)
        // _object_get 故意不调 getter(gOPD 要标记块);assign 须 Get 后显式 _maybe_getter。
        vm.store(VReg.SP, 8, VReg.S0); // 保 boxed to
        vm.store(VReg.SP, 16, VReg.S1); // 保 boxed source
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V4);
        vm.andMaskReg(VReg.S1, VReg.S1, VReg.V4);

        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_object_assign_done");
        // TYPE_PROXY: count@8 is [[ProxyTarget]], not a prop count. Use
        // [[OwnPropertyKeys]] + [[GetOwnProperty]] (CopyDataProperties / assign).
        vm.loadByte(VReg.V2, VReg.S1, 0);
        vm.cmpImm(VReg.V2, TYPE_PROXY);
        vm.jeq("_object_assign_src_proxy");

        vm.load(VReg.S2, VReg.S1, 8); // source count
        vm.movImm(VReg.S3, 0);

        // 防御：source props_ptr 为 NULL → 视作无自有属性
        vm.load(VReg.V0, VReg.S1, OBJECT_PROPS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_object_assign_done");

        // [enum-order] source 枚举前归一(整数键 → 字符串键 → symbol)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_normalize_order");

        vm.label("_object_assign_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_object_assign_done");

        // 可枚举判别:flags_ptr==0 → 默认可枚举;否则 flags[idx]&ENUMERABLE==0 → 跳过
        vm.load(VReg.V2, VReg.S1, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_assign_take");
        vm.add(VReg.V2, VReg.V2, VReg.S3);
        vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.movImm(VReg.V0, ATTR_ENUMERABLE);
        vm.and(VReg.V2, VReg.V2, VReg.V0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_assign_next");

        vm.label("_object_assign_take");
        vm.load(VReg.V2, VReg.S1, OBJECT_PROPS_PTR_OFFSET);
        vm.shl(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);

        vm.load(VReg.V1, VReg.V0, 0); // key
        vm.store(VReg.SP, 0, VReg.V1);
        vm.load(VReg.A0, VReg.SP, 16); // boxed source(Receiver/this)
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.call("_maybe_getter"); // 触发 accessor(strings-and-symbol-order)

        // Set(to, key, value, true) — 失败抛 TypeError
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 8); // boxed to
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_assign_set");

        vm.label("_object_assign_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_assign_loop");

        vm.label("_object_assign_done");
        // 返回入口 ToObject 后的 boxed to(SP+8),勿用裸指针重装箱(会丢 Number/String 身份)
        vm.load(VReg.RET, VReg.SP, 8);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_object_assign_nullish_tgt");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");

        vm.label("_object_assign_ret_tgt");
        vm.mov(VReg.RET, VReg.S0); // ToObject 后的 target
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // source string → to[i] = char(Set Throw)
        vm.label("_object_assign_src_str");
        // S0=boxed to, S1=boxed source
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_object_assign_str_loop");
        vm.cmp(VReg.S3, VReg.S2); vm.jge("_object_assign_idx_ret");
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0);
        vm.call("_valueToStr");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_charAt");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_assign_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_assign_str_loop");

        // source array → to[i] = a[i]
        vm.label("_object_assign_src_arr");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_object_assign_arr_loop");
        vm.cmp(VReg.S3, VReg.S2); vm.jge("_object_assign_idx_ret");
        vm.scvtf(0, VReg.S3); vm.fmovToInt(VReg.A0, 0);
        vm.call("_valueToStr");
        vm.store(VReg.SP, 0, VReg.RET);
        // Object.assign copies own enumerable properties, not every position
        // below Array length.  A sparse source hole must leave the target's
        // existing element untouched (and inherited prototype elements are
        // not source own properties either).
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_assign_arr_next");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_assign_set");
        vm.label("_object_assign_arr_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_assign_arr_loop");

        vm.label("_object_assign_idx_ret");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // Proxy source: ownKeys trap order, then gOPD (even if desc is undefined).
        vm.label("_object_assign_src_proxy");
        vm.load(VReg.A0, VReg.SP, 16);
        vm.call("_object_own_keys_all");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_length");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_object_assign_px_loop");
        vm.cmp(VReg.S3, VReg.S0);
        vm.jge("_object_assign_done");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 16);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.store(VReg.SP, 24, VReg.RET);
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFD);
        vm.jne("_object_assign_px_next");
        vm.load(VReg.A0, VReg.SP, 24);
        vm.lea(VReg.A1, vm.asm.addString("enumerable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.movImm64(VReg.V1, 0x7ff9000000000001n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_object_assign_px_next");
        vm.load(VReg.A0, VReg.SP, 16);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.call("_maybe_getter");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 8);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_assign_set");
        vm.label("_object_assign_px_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_object_assign_px_loop");
    }

    // _object_assign_set(to, key, value): Set(O, P, V, true)
    // 自有不可写数据 / 无 setter 访问器 / non-extensible 新增 → TypeError;
    // 其余委托 _object_set(setter 抛错自然传播)。
    generateObjectAssignSet() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_object_assign_set");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // to (boxed/raw)
        vm.mov(VReg.S1, VReg.A1); // key
        vm.mov(VReg.S2, VReg.A2); // value
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S3, VReg.S0, VReg.V1); // raw
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_oas_do_set");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jlt("_oas_do_set");
        vm.loadByte(VReg.V0, VReg.S3, 0);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jeq("_oas_array");
        vm.cmpImm(VReg.V0, TYPE_OBJECT);
        vm.jne("_oas_do_set"); // 数组等交 _object_set(本簇证据均为普通对象/String wrapper)

        // 扫自有键
        vm.load(VReg.S4, VReg.S3, 8); // count
        vm.movImm(VReg.S5, 0);
        vm.label("_oas_find");
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge("_oas_miss");
        vm.load(VReg.V2, VReg.S3, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S5, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_oas_hit");
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_oas_find");

        vm.label("_oas_hit");
        // 访问器?
        vm.load(VReg.V2, VReg.S3, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S5, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.V0, VReg.V0, 8); // old value
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_oas_data");
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_oas_data");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_oas_data");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_oas_data");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER);
        vm.jne("_oas_data");
        // getter-only → Throw
        vm.load(VReg.V1, VReg.V0, 16); // setter
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_oas_throw");
        vm.jmp("_oas_do_set"); // 有 setter → 交给 _object_set

        vm.label("_oas_data");
        // frozen 或 per-prop !writable → Throw
        vm.loadByte(VReg.V0, VReg.S3, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_FROZEN);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_oas_throw");
        vm.load(VReg.V0, VReg.S3, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_oas_do_set"); // 无 flags → 默认可写
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.andImm(VReg.V0, VReg.V0, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_oas_throw");
        vm.jmp("_oas_do_set");

        vm.label("_oas_miss");
        // 新增:non-extensible → Throw
        vm.loadByte(VReg.V0, VReg.S3, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_NONEXT);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_oas_throw");
        vm.jmp("_oas_do_set");

        vm.label("_oas_array");
        // `_object_set` routes non-index array names to the side table, but
        // Array [[Set]] treats "length" as the exotic length property.  Use
        // the shared strict length setter so Object.assign(target,{length:n})
        // shrinks/grows the array and propagates RangeError/TypeError.
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_oas_do_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_agen_setlength_throw");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        vm.label("_oas_throw");
        vm.lea(VReg.A0, vm.asm.addString("Cannot assign to read only property"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");

        vm.label("_oas_do_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
    }

    // [rest] 对象解构 rest:_object_rest(src, excludedKeysArray) -> 新对象
    // CopyDataProperties:对 src 每个自有键,未被 excluded 且 enumerable,
    // 则 value = Get(src, key)(触发 getter),再 CreateDataProperty(result, key, value)。
    // src = boxed 对象;excluded = JS 数组(元素为 boxed 字符串键,可空)。
    // 全程用栈槽保存循环状态,免依赖被调用 helper 的 S 寄存器保存契约。
    // 栈布局(prologue 96, 16B 对齐):
    //   +0 src裸指针  +8 src count  +16 i  +24 excluded指针  +32 excluded长度
    //   +40 result  +48 当前key  +56 (unused)  +64 j  +72 src装箱(原始 A0)
    generateObjectRest() {
        const vm = this.vm;

        vm.label("_object_rest");
        vm.prologue(96, []);

        vm.store(VReg.SP, 72, VReg.A0);  // 原始装箱 src(供 [[Get]] / _maybe_getter this)
        vm.store(VReg.SP, 80, VReg.A1);  // excluded(入口 ToObject helper 会破坏 A1)

        // CopyDataProperties first applies ToObject to every non-nullish
        // primitive. Number/Boolean/BigInt/Symbol wrappers have no enumerable
        // own properties, so their rest result is an empty ordinary object.
        // String wrappers do expose enumerable UTF-16 index properties; reuse
        // _string_new so the existing object-copy loop sees the right keys.
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_object_rest_src_string");
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_object_rest_src_empty");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_object_rest_src_empty");
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_object_rest_src_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_object_rest_src_nullish");
        vm.cmpImm(VReg.V0, 0); vm.jeq("_object_rest_src_raw");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_object_rest_src_ready");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_object_rest_src_ready");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_object_rest_src_ready");
        // Ordinary positive/negative floating-point values.
        vm.jmp("_object_rest_src_empty");

        vm.label("_object_rest_src_string");
        vm.load(VReg.A0, VReg.SP, 72);
        vm.call("_string_new");
        vm.store(VReg.SP, 72, VReg.RET);
        vm.jmp("_object_rest_src_ready");

        vm.label("_object_rest_src_raw");
        // high16==0 is shared by raw heap pointers and +0/subnormals.
        vm.load(VReg.V0, VReg.SP, 72);
        vm.cmpImm(VReg.V0, 0); vm.jeq("_object_rest_src_empty");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1); vm.jlt("_object_rest_src_empty");
        vm.load(VReg.A0, VReg.SP, 72);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0); vm.jne("_object_rest_src_empty");
        vm.load(VReg.A0, VReg.SP, 72);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jne("_object_rest_src_empty");

        vm.label("_object_rest_src_ready");
        vm.load(VReg.A0, VReg.SP, 72);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V4);
        vm.store(VReg.SP, 0, VReg.V0);   // src 指针
        // [enum-order] 与 _object_keys 同规:枚举前把源对象自有属性归一到 ES 规范序
        // (整数键升序在前、字符串按插入序、Symbol 殿后),rest 的复制序才与
        // Object.keys/规范一致(obj-rest-order 族)。归一就地重排、幂等。
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_object_normalize_order");
        vm.load(VReg.V0, VReg.SP, 0);    // 重载(归一可能动 props 指针)
        vm.load(VReg.V1, VReg.SP, 80);
        vm.andMaskReg(VReg.V0, VReg.V1, VReg.V4);
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

        // 可枚举判别(复用 _object_keys):flags_ptr==0 → 默认可枚举(自举对象);
        // 否则 flags[i]&ATTR_ENUMERABLE==0 → 跳过(obj-ptrn-rest-skip-non-enumerable)
        vm.load(VReg.V2, VReg.SP, 0);
        vm.load(VReg.V2, VReg.V2, OBJECT_FLAGS_PTR_OFFSET);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_rest_enum_ok");
        vm.load(VReg.V0, VReg.SP, 16);             // i
        vm.add(VReg.V2, VReg.V2, VReg.V0);
        vm.loadByte(VReg.V2, VReg.V2, 0);
        vm.movImm(VReg.V0, ATTR_ENUMERABLE);
        vm.and(VReg.V2, VReg.V2, VReg.V0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_object_rest_skip");               // 不可枚举 → 跳过

        vm.label("_object_rest_enum_ok");
        // propAddr = src.props_ptr + i*16(只取 key;值走 [[Get]],不读槽裸 val)
        vm.load(VReg.V2, VReg.SP, 0);
        vm.load(VReg.V2, VReg.V2, OBJECT_PROPS_PTR_OFFSET);
        vm.load(VReg.V0, VReg.SP, 16);
        vm.shl(VReg.V0, VReg.V0, 4);
        vm.add(VReg.V2, VReg.V2, VReg.V0);
        vm.load(VReg.V1, VReg.V2, 0);
        vm.store(VReg.SP, 48, VReg.V1);  // key

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
        // [rest-computed-key] ToPropertyKey 归一:计算键 {[a]:b,...rest} 的 a 是数字时
        // 排除项是数字 1.0(float 位),而源对象存的是字符串键 "1" —— 不归一化恒不命中
        // → rest 漏排 "1"(obj-rest-non-string-computed-property 族)。
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_prop_key");         // number → 规范索引串;string/symbol 原样
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
        // [[Get]] + _maybe_getter:触发 getter,把数据值(非标记块)写入 rest
        vm.load(VReg.A0, VReg.SP, 72);   // 原始装箱 src
        vm.load(VReg.A1, VReg.SP, 48);   // key
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);       // value(可能含 getter 标记)
        vm.load(VReg.A1, VReg.SP, 72);   // this = 装箱 src
        vm.call("_maybe_getter");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40);   // result
        vm.load(VReg.A1, VReg.SP, 48);   // key
        vm.call("_object_set");

        vm.label("_object_rest_skip");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.jmp("_object_rest_loop");

        vm.label("_object_rest_src_empty");
        vm.call("_object_new");
        vm.store(VReg.SP, 40, VReg.RET);
        vm.jmp("_object_rest_done");

        vm.label("_object_rest_src_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");

        vm.label("_object_rest_done");
        vm.load(VReg.RET, VReg.SP, 40);
        // [修复] _object_new 返回裸指针(装箱由调用方负责);补 0x7FFD 对象标签,
        // 否则 typeof rest→"number"、JSON.stringify(rest)→0(裸指针高16=0 被当
        // 小 double)。属性访问/Object.keys 兼容裸指针而侥幸工作,掩盖此漏。
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([], 96);
    }

    // Object.create(proto) -> obj
    generateObjectCreate() {
        const vm = this.vm;

        vm.label("_object_create");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // proto (boxed)

        // Type check: proto must be null or an object (ES 19.1.2.2 step 1).
        // null (0x7FFA) → valid (Object.create(null))
        // undefined (0x7FFB) → TypeError
        // number/bool/string/symbol → TypeError
        // +0.0 is IEEE 0 (high16=0). Same +0 check as _object_assign ToObject:
        // must not take the raw-pointer path (Object.create(0) TypeError).
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_object_create_typeerr");
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);        // null tag
        vm.jeq("_object_create_null");
        vm.cmpImm(VReg.V1, 0x7FFD);        // Object tag
        vm.jeq("_object_create_obj");
        vm.cmpImm(VReg.V1, 0);             // raw heap pointer (internal callers)
        vm.jeq("_object_create_obj");
        // Not null and not object → TypeError
        vm.label("_object_create_typeerr");
        vm.lea(VReg.A0, vm.asm.addString("Object prototype may only be an Object or null"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        vm.label("_object_create_null");
        vm.movImm(VReg.S0, 0);             // proto = 0 (null)
        vm.jmp("_object_create_do");

        vm.label("_object_create_obj");
        // 指针脱壳 (使用 S2 作为临时，保存到栈后不再使用)
        vm.emitMaskLoad(VReg.S2);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.S2);

        vm.label("_object_create_do");
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

        // _nsobj_array_proto data slot (lazy, filled by _ensure_array_proto or emitArrayCtorObject).
        vm.asm.addDataLabel("_nsobj_array_proto");
        vm.asm.addDataQword(0);
        // 0 while _nsobj_array_proto is merely the empty Array-exotic shell; set to 1
        // by emitArrayCtorObject after all intrinsic Array.prototype methods land.
        vm.asm.addDataLabel("_nsobj_array_ready");
        vm.asm.addDataQword(0);
        // _nsobj_string_proto data slot (for getPrototypeOf <-> String.prototype).
        // Materialized by emitStringProtoObject (members.js). Declared here as runtime fallback
        // reference so _object_getPrototypeOf can read the slot even when emitStringProtoObject
        // hasn't been emitted into a specific compilation unit.
        vm.asm.addDataLabel("_nsobj_string_proto");
        vm.asm.addDataQword(0);
        // Date.prototype 槽(members.js 物化;此处声明以便 _object_get_date_side 可链)
        vm.asm.addDataLabel("_nsobj_date_proto");
        vm.asm.addDataQword(0);
        // Date.prototype 槽(members.js 物化;此处声明以便 _object_get_date_side 可链)
        vm.asm.addDataLabel("_nsobj_date_proto");
        vm.asm.addDataQword(0);
        // Function.prototype 槽(members.js emitFunctionProtoObject 同槽;此处登记以便
        // getPrototypeOf(fn)/Number/Error 在编译单元未触发 Function.prototype 值读时
        // 仍能惰性物化同一单例)。
        vm.asm.addDataLabel("_nsobj_function_proto");
        vm.asm.addDataQword(0);
        // Error 构造器一等值槽(members.js emitErrorCtorRef 同名;此处预登记避免
        // getPrototypeOf(TypeError)===Error 缺符号。members 侧再 add 会占双 qword,
        // finalize 同名标签取后者——两侧仍落到同一活动槽)。
        vm.asm.addDataLabel("_errctorref_Error");
        vm.asm.addDataQword(0);
        const _gpoErrSubs = ["TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"];
        for (let _ei = 0; _ei < _gpoErrSubs.length; _ei = _ei + 1) {
            vm.asm.addDataLabel("_errctorref_" + _gpoErrSubs[_ei]);
            vm.asm.addDataQword(0);
        }

        // _ensure_array_proto: fill _nsobj_array_proto if empty.  The intrinsic
        // prototype is a real zero-length Array exotic whose own prototype is
        // Object.prototype (stored in the per-array override table).
        vm.label("_ensure_array_proto");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_eap_done");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");
        vm.mov(VReg.S0, VReg.RET);
        // Initialise the Object.prototype override before publishing the
        // intrinsic array. Publishing first lets lazy Object.prototype setup
        // recurse through a half-built Array.prototype on hole lookup.
        vm.call("_object_proto_ensure");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_set_instance_proto");
        vm.lea(VReg.V1, "_nsobj_array_proto");
        vm.store(VReg.V1, 0, VReg.S0);
        vm.label("_eap_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // _ensure_function_proto: 惰性单例 Function.prototype(与 emitFunctionProtoObject 同槽)。
        // 仅建空对象;call/apply 仍由 members 路径在槽空时补挂——若本路径先填槽,
        // members 复用同一对象(身份稳定);静态链 Function.prototype.call 不经对象属性。
        vm.label("_ensure_function_proto");
        // Empty proto (old skip) left fn.call undefined on callable Proxy
        // (Get forwards to function target → gPO → this proto). Hang
        // call/apply/bind as 24B {_aref_static_tramp, _fp_*_tramp} so
        // p.call / Function.prototype.call ABI (A5=fn) works. Slot reuse
        // matches emitFunctionProtoObject.
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.lea(VReg.V1, "_nsobj_function_proto");
        vm.load(VReg.S0, VReg.V1, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jne("_efp_have");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V1, "_nsobj_function_proto");
        vm.store(VReg.V1, 0, VReg.S0);
        vm.label("_efp_have");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("call"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_efp_done");
        const efpHang = (name, helper) => {
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");
            vm.mov(VReg.S1, VReg.RET);
            vm.movImm(VReg.V1, 0xc105);
            vm.store(VReg.S1, 0, VReg.V1);
            vm.lea(VReg.V1, "_aref_static_tramp");
            vm.store(VReg.S1, 8, VReg.V1);
            vm.lea(VReg.V1, helper);
            vm.store(VReg.S1, 16, VReg.V1);
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_js_box_function");
            vm.mov(VReg.A2, VReg.RET); // x64 V2≡A2; key boxing uses V1≡A3
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString(name));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.call("_object_set");
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString(name));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.movImm(VReg.A2, 5);
            vm.call("_object_set_prop_attr");
        };
        efpHang("call", "_fp_call_tramp");
        efpHang("apply", "_fp_apply_tramp");
        efpHang("bind", "_fp_bind_tramp");
        vm.label("_efp_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _ensure_string_proto: 惰性 String.prototype(同 _nsobj_string_proto)。
        // 最小挂 valueOf/toString → _str_valueOf/_str_toString_wrapper(闭包),
        // 与 emitStringCtorObject 同槽:先到者填,后者复用 → 身份稳定。
        // Object.assign ToObject(string) 依赖此槽;无 String 值读的单元也能 valueOf。
        vm.label("_ensure_string_proto");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.lea(VReg.V0, "_nsobj_string_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_esp_have");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V1, "_nsobj_string_proto");
        vm.store(VReg.V1, 0, VReg.S0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.A2, vm.asm.addString(""));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 0);
        vm.call("_object_set_prop_attr");
        // valueOf 闭包(24B aref 蹦床:this=A5 → A0)
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S1, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.S1, 8, VReg.V1);
        vm.lea(VReg.V1, "_str_valueOf");
        vm.store(VReg.S1, 16, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_box_function");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("valueOf"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_set");
        // toString 闭包
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S1, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.S1, 8, VReg.V1);
        vm.lea(VReg.V1, "_str_toString_wrapper");
        vm.store(VReg.S1, 16, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_box_function");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("toString"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_set");
        vm.mov(VReg.V0, VReg.S0);
        vm.label("_esp_have");
        vm.mov(VReg.RET, VReg.V0); // both paths: RET = boxed String.prototype
        vm.epilogue([VReg.S0, VReg.S1], 16);


        // _ensure_boolean_proto: 惰性 Boolean.prototype(同 _nsobj_boolean_proto)。
        // 规范 Boolean.prototype 是 [[BooleanData]]=false 的布尔包装;此处落
        // __boolean_value=false,与 emitBooleanCtorObject 身份共享(先到者填槽)。
        vm.label("_ensure_boolean_proto");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.V0, "_nsobj_boolean_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ebp_have");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.lea(VReg.V1, "_nsobj_boolean_proto");
        vm.store(VReg.V1, 0, VReg.RET);
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__boolean_value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.A2, 0x7FF9000000000000n); // false
        vm.call("_object_set");
        vm.mov(VReg.V0, VReg.S0);
        vm.label("_ebp_have");
        vm.mov(VReg.RET, VReg.V0); // both paths: RET = boxed Boolean.prototype
        vm.epilogue([VReg.S0], 0);

        // _ensure_number_proto: 惰性 Number.prototype(同 _nsobj_number_proto)。
        // 规范 Number.prototype 是 [[NumberData]]=+0 的包装;此处落
        // __number_value=+0,与 emitNumberCtorObject 身份共享(先到者填槽)。
        vm.label("_ensure_number_proto");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.V0, "_nsobj_number_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_enp_have");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.lea(VReg.V1, "_nsobj_number_proto");
        vm.store(VReg.V1, 0, VReg.RET);
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("__number_value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.A2, 0x0000000000000000n); // +0.0
        vm.call("_object_set");
        vm.mov(VReg.V0, VReg.S0);
        vm.label("_enp_have");
        vm.mov(VReg.RET, VReg.V0); // both paths: RET = boxed Number.prototype
        vm.epilogue([VReg.S0], 0);

        // _ensure_date_proto: 惰性 Date.prototype 单例(同 _nsobj_date_proto)。
        vm.label("_ensure_date_proto");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.V0, "_nsobj_date_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_edp_done");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.lea(VReg.V1, "_nsobj_date_proto");
        vm.store(VReg.V1, 0, VReg.RET);
        vm.label("_edp_done");
        vm.epilogue([VReg.S0], 0);

        // _ensure_error_ctor: 惰性物化 Error 构造器单例(_errctorref_Error)。
        // getPrototypeOf(TypeError) 在 `=== Error` 求值之前就需要 Error 身份;
        // 仅读槽会在 Error 值读尚未触发时得 0 → 误回落 Function.prototype。
        // 与 emitErrorCtorRef("Error") 同槽:先到者填,后者复用 → 身份稳定。
        vm.label("_ensure_error_ctor");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.V0, "_errctorref_Error");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_eec_done");
        // 16B 闭包 {magic, _object_new}(与 emitErrorCtorRef 占位 fn 同形)
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_object_new");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V1, "_errctorref_Error");
        vm.store(VReg.V1, 0, VReg.S0);
        // .name = "Error"(assert / print 友好;emitErrorCtorRef 复用时保留)
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.A2, vm.asm.addString("Error"));
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_closure_prop_set");
        vm.lea(VReg.V0, "_errctorref_Error");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.label("_eec_done");
        vm.epilogue([VReg.S0], 0);

        vm.label("_object_getPrototypeOf");
        vm.prologue(32, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // 保存原始输入

        // +0.0 is IEEE 0 (high16=0). Must not take the raw-pointer path
        // (payload 0 → null). Same +0 check as _object_assign ToObject;
        // ToObject(+0) → Number wrapper → Number.prototype.
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_gpo_number_proto");

        // 类型检查: 必须是 Object (0x7FFD) / Array (0x7FFE) / 裸堆指针 (高16位=0)
        vm.shrImm(VReg.S1, VReg.A0, 48);
        vm.cmpImm(VReg.S1, 0); // 裸堆指针（未装箱的对象指针，兼容旧调用点）
        vm.jeq("_object_getPrototypeOf_tag_ok");
        vm.cmpImm(VReg.S1, 0x7FFD); // Object
        vm.jeq("_object_getPrototypeOf_tag_ok");
        vm.cmpImm(VReg.S1, 0x7FFE); // Array
        vm.jeq("_object_getPrototypeOf_tag_ok");
        // null/undefined → TypeError(ToObject 规范,ES 20.1.2.12 step 1)
        vm.cmpImm(VReg.S1, 0x7FFA); vm.jeq("_object_getPrototypeOf_nullish");
        vm.cmpImm(VReg.S1, 0x7FFB); vm.jeq("_object_getPrototypeOf_nullish");

        // 其余基元:按 ES 返回对应包装类型的原型(惰性 ensure 槽,与 Xxx.prototype 同身份)
        vm.cmpImm(VReg.S1, 0x7FF9); // Boolean
        vm.jeq("_gpo_boolean_proto");
        vm.cmpImm(VReg.S1, 0x7FF8); // Number (tagged int)
        vm.jeq("_gpo_number_proto");
        vm.cmpImm(VReg.S1, 0x7FFC); // String
        vm.jeq("_gpo_string_proto");
        // Function(0x7FFF):[[Prototype]] 通常 Function.prototype;Error 子类 → Error
        vm.cmpImm(VReg.S1, 0x7FFF);
        vm.jeq("_gpo_function");
        // 其余非 tagged 值(裸 float64 位模式等)→ Number.prototype
        // 浮点值的高 16 位是 IEEE 754 指数+符号,不匹配任何 tagged sentinel。
        // Symbol 等非标准 tagged 值也会落此(偏差:Symbol→Number.prototype)。
        vm.jmp("_gpo_number_proto");
        vm.label("_gpo_function");
        // The three dynamic-function constructors are subclasses of Function:
        // their own [[Prototype]] is the Function constructor singleton, not
        // Function.prototype.  Identity slots are zero until materialized.
        for (const _slot of ["_opts_genfunc_ctor", "_opts_asyncfunc_ctor", "_asyncgenfunc_singleton"]) {
            const _next = `_gpo_kind_ctor_next_${_slot}`;
            vm.lea(VReg.V0, _slot);
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, 0); vm.jeq(_next);
            vm.cmp(VReg.S0, VReg.V0); vm.jeq("_gpo_kind_ctor_parent");
            vm.label(_next);
        }
        // TypedArray 族构造器闭包 → %TypedArray%(harness: Object.getPrototypeOf(Int8Array))
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.load(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, 0xc105);
        vm.jne("_gpo_ta_done");
        vm.load(VReg.V0, VReg.V2, 16);
        vm.cmpImm(VReg.V0, 0x70);
        vm.jeq("_gpo_ta_done");
        vm.cmpImm(VReg.V0, 0x40);
        vm.jlt("_gpo_ta_done");
        vm.cmpImm(VReg.V0, 0x61);
        vm.jgt("_gpo_ta_done");
        vm.call("_ta_intrinsic");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_ta_ensure_species");
        vm.jmp("_gpo_ret");
        vm.label("_gpo_ta_done");
        // Function-kind intrinsics have distinct [[Prototype]] objects.  The
        // compact function value does not carry a normal object proto slot, so
        // select it from the code-pointer metadata table.
        vm.load(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, 0xc105); vm.jeq("_gpo_function_meta_closure");
        vm.cmpImm(VReg.V0, 0xa51c); vm.jeq("_gpo_function_meta_closure");
        vm.mov(VReg.A0, VReg.V2);
        vm.jmp("_gpo_function_meta_find");
        vm.label("_gpo_function_meta_closure");
        vm.load(VReg.A0, VReg.V2, 8);
        vm.label("_gpo_function_meta_find");
        // CreateDynamicFunction may select NewTarget.prototype rather than the
        // intrinsic kind prototype.  Mmap closures keep that exact value in
        // their dynamic metadata node because the compact closure layout has
        // no ordinary-object [[Prototype]] slot.
        vm.store(VReg.SP, 0, VReg.A0);
        vm.call("_dynamic_fn_meta_proto");
        vm.cmpImm(VReg.RET, 0); vm.jne("_gpo_ret");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_func_meta_find");
        vm.cmpImm(VReg.RET, 1); vm.jeq("_gpo_genfunc_proto");
        vm.cmpImm(VReg.RET, 2); vm.jeq("_gpo_asyncfunc_proto");
        vm.cmpImm(VReg.RET, 3); vm.jeq("_gpo_asyncgenfunc_proto");
        vm.jmp("_gpo_function_ordinary");
        vm.label("_gpo_genfunc_proto");
        vm.call("_ensure_genfunc_ctor");
        vm.lea(VReg.V0, "_nsobj_genfunc_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.jmp("_gpo_ret");
        vm.label("_gpo_asyncfunc_proto");
        vm.call("_ensure_asyncfunc_ctor");
        vm.lea(VReg.V0, "_nsobj_asyncfunc_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.jmp("_gpo_ret");
        vm.label("_gpo_asyncgenfunc_proto");
        vm.call("_ensure_asyncgenfunc_tag_proto");
        vm.jmp("_gpo_ret");
        vm.label("_gpo_function_ordinary");
        // Error 子类构造器:身份比对 _errctorref_* → 返 Error 构造器
        for (let _ei = 0; _ei < _gpoErrSubs.length; _ei = _ei + 1) {
            const _lab = "_gpo_errsub_" + _ei;
            vm.lea(VReg.V0, "_errctorref_" + _gpoErrSubs[_ei]);
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, 0);
            vm.jeq(_lab);
            vm.cmp(VReg.S0, VReg.V0);
            vm.jeq("_gpo_error_ctor");
            vm.label(_lab);
        }
        // 普通函数/内建构造器 → Function.prototype
        vm.call("_ensure_function_proto");
        vm.lea(VReg.V0, "_nsobj_function_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.jmp("_gpo_ret");
        vm.label("_gpo_kind_ctor_parent");
        vm.call("_ensure_function_ctor_runtime");
        vm.jmp("_gpo_ret");
        vm.label("_gpo_error_ctor");
        vm.call("_ensure_error_ctor");
        vm.lea(VReg.V0, "_errctorref_Error");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.jmp("_gpo_ret");
        vm.label("_gpo_boolean_proto");
        vm.call("_ensure_boolean_proto");
        vm.lea(VReg.V0, "_nsobj_boolean_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.jmp("_gpo_ret");
        vm.label("_gpo_number_proto");
        vm.call("_ensure_number_proto");
        vm.lea(VReg.V0, "_nsobj_number_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.jmp("_gpo_ret");
        vm.label("_gpo_string_proto");
        vm.call("_ensure_string_proto");
        vm.lea(VReg.V0, "_nsobj_string_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.label("_gpo_ret");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_gpo_ret_ok");
        // 槽未物化 → 回退 undefined
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.label("_gpo_ret_ok");
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_object_getPrototypeOf_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        vm.label("_object_getPrototypeOf_tag_ok");
        // %AsyncGenerator.prototype% → %AsyncIteratorPrototype%
        // (identity; Object.create(AIP) proto slot can be 0 after later writes).
        vm.lea(VReg.V0, "_nsobj_asyncgen_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_gpo_agp_skip");
        vm.cmp(VReg.A0, VReg.V0);
        vm.jne("_gpo_agp_skip");
        vm.call("_ensure_async_iterator_proto");
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_gpo_agp_skip");
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
        // Array(type=1) has no __proto__ slot (layout: type@0,length@8,capacity@16,data_ptr@24).
        // Reading capacity as __proto__ pointer causes SIGSEGV.
        vm.cmpImm(VReg.V0, 1); /* TYPE_ARRAY */
        vm.jeq("_gpo_array");
        // TYPE_OBJECT and classinfo (type=3, same header: __proto__@16).
        // Old TYPE_OBJECT-only check sent every class to unsupported →
        // getPrototypeOf(class C{}) === undefined (Custom.resolve inherit fail).
        vm.cmpImm(VReg.V0, TYPE_OBJECT);
        vm.jeq("_gpo_read_proto");
        vm.cmpImm(VReg.V0, 3); // TYPE_FUNCTION / classinfo
        vm.jne("_object_getPrototypeOf_unsupported");
        vm.label("_gpo_read_proto");

        // 加载 __proto__
        vm.load(VReg.RET, VReg.S1, 16); // RET = __proto__ (裸指针)

        // 检查是否为 null
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_getPrototypeOf_null");

        // __proto__ 指向 classinfo(type@0==3=FUNCTION)→ 原样返回裸 classinfo 指针:
        // 类值在本运行时即裸 classinfo(读类名标识符不加 tag),故 `Object.getPrototypeOf(
        // 子类) === 父类` 按指针相等成立;typeof 对裸指针读 type@0==3 得 "function"。
        // 普通原型对象则按对象标记(0x7FFD)。S1(裸输入)此后不再用,借作临时。
        vm.load(VReg.S1, VReg.RET, 0); // type@0 / closure magic
        vm.cmpImm(VReg.S1, 3);
        vm.jeq("_object_getPrototypeOf_fn");
        vm.cmpImm(VReg.S1, 0xc105);
        vm.jeq("_gpo_box_fn");
        vm.cmpImm(VReg.S1, 0xa51c);
        vm.jeq("_gpo_box_fn");
        vm.andImm(VReg.S1, VReg.S1, 0xff); // type 低字节(高字节可含标志位)
        vm.cmpImm(VReg.S1, 3);
        vm.jeq("_object_getPrototypeOf_fn");
        // Box proto as 0x7FFD. x64 orImm is OR r64, imm32 — the tag
        // 0x7ffd000000000000 truncates to 0, so gPO returned a naked
        // pointer while Xxx.prototype is slot-boxed via _box_obj_r.
        // Root of getPrototypeOf(new Number(0)) === Number.prototype
        // being false (instanceof still walked the unboxed __proto__@16).
        vm.call("_box_obj_r");
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_gpo_box_fn");
        // Builtin ctor parent (Promise/Map/…): same 0x7FFF box as identifier.
        // movImm64+or — x64 orImm truncates the 0x7FFF tag to 0.
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_object_getPrototypeOf_fn");
        // RET 已是裸 classinfo 指针,原样返回(与类值表示一致)
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // Array prototype: lazy ensure then return.
        // arguments 异质对象(byte1 ARR_IS_ARGUMENTS):[[Prototype]] 是
        // Object.prototype,不是 Array.prototype(15.2.3.6-3-96-1 / 175-1)。
        vm.label("_gpo_array");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_get_instance_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_gpo_array_override");
        vm.loadByte(VReg.V0, VReg.S1, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_gpo_object_proto");
        vm.call("_ensure_array_proto");
        vm.lea(VReg.V0, "_nsobj_array_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_getPrototypeOf_null");
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_gpo_array_override");
        // The side table stores the exact boxed prototype (including tagged
        // null), so return it without consulting the intrinsic Array.prototype.
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_gpo_object_proto");
        vm.call("_object_proto_ensure");
        vm.lea(VReg.V0, "_nsobj_object_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_getPrototypeOf_null");
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // Date:无 __proto__@16(ts 槽),返 Date.prototype 单例。
        vm.label("_gpo_date");
        vm.call("_ensure_date_proto");
        vm.lea(VReg.V0, "_nsobj_date_proto");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_object_getPrototypeOf_null");
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // 非标准对象类型无 __proto__@16。Date/Map/Set/Promise(含 Weak*) 返对应
        // 原型单例。槽空时先落空对象(与 _ensure_date_proto 同形);随后
        // emitCollectionProtoObject 见 proto 已填但 ctor 未填会补挂方法并复用
        // 同一对象 → getPrototypeOf(x) === X.prototype。
        vm.label("_object_getPrototypeOf_unsupported");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, TYPE_DATE);
        vm.jeq("_gpo_date");
        vm.cmpImm(VReg.V0, 4); // TYPE_MAP / WeakMap
        vm.jeq("_gpo_map");
        vm.cmpImm(VReg.V0, 5); // TYPE_SET / WeakSet
        vm.jeq("_gpo_set");
        vm.cmpImm(VReg.V0, 11); // TYPE_PROMISE
        vm.jeq("_gpo_promise");
        vm.cmpImm(VReg.V0, TYPE_SYMBOL);
        vm.jeq("_gpo_symbol");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_gpo_symbol");
        vm.call("_ensure_symbol_proto");
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_gpo_map");
        vm.load(VReg.V0, VReg.S1, 48); // weakness
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_gpo_weakmap");
        vm.lea(VReg.S0, "_nsobj_map_proto");
        vm.jmp("_gpo_coll_ensure");
        vm.label("_gpo_weakmap");
        vm.lea(VReg.S0, "_nsobj_weakmap_proto");
        vm.jmp("_gpo_coll_ensure");
        vm.label("_gpo_set");
        vm.load(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_gpo_weakset");
        vm.lea(VReg.S0, "_nsobj_set_proto");
        vm.jmp("_gpo_coll_ensure");
        vm.label("_gpo_weakset");
        vm.lea(VReg.S0, "_nsobj_weakset_proto");
        vm.jmp("_gpo_coll_ensure");
        vm.label("_gpo_promise");
        // Subclass proto lives at +48 after _promise_super_init (TYPE_OBJECT +16 moved).
        vm.load(VReg.V2, VReg.S1, 48);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_gpo_promise_def");
        vm.mov(VReg.RET, VReg.V2);
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_gpo_promise_have");
        vm.call("_box_obj_r");
        vm.label("_gpo_promise_have");
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_gpo_promise_def");
        vm.call("_ensure_promise_proto");
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_gpo_coll_ensure");
        vm.load(VReg.RET, VReg.S0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_gpo_coll_have");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.store(VReg.S0, 0, VReg.RET);
        vm.label("_gpo_coll_have");
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // 原型为空 → 规范 null 单例(旧实现返裸 0,`gPO(Object.create(null)) === null` 恒假)
        vm.label("_object_getPrototypeOf_null");
        vm.lea(VReg.RET, "_js_null");
        vm.load(VReg.RET, VReg.RET, 0);
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
    // ES:先 Type(V) 非 Object → false,再 ToObject(this);故 null this + 原语 V 返 false 不抛。
    generateIsPrototypeOf() {
        const vm = this.vm;
        vm.label("_is_prototype_of");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // this/proto(boxed) — 跨 _is_symbol 存活
        vm.mov(VReg.S1, VReg.A1); // V(boxed)
        // Step 1: If Type(V) is not Object, return false (before ToObject(this)).
        vm.shrImm(VReg.V0, VReg.S1, 48);   // x tag
        vm.cmpImm(VReg.V0, 0x7FFD);        // 装箱对象
        vm.jeq("_ipo_v_obj");
        vm.cmpImm(VReg.V0, 0x7FFE);        // Array(ES Object;链走下方另判)
        vm.jeq("_ipo_v_obj");
        vm.cmpImm(VReg.V0, 0x7FFF);        // Function(ES Object)
        vm.jeq("_ipo_v_obj");
        vm.cmpImm(VReg.V0, 0);             // 裸堆指针候选
        vm.jne("_ipo_false");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_ipo_false");             // +0.0 非对象
        // Symbol/BigInt 裸堆非 Object → false(官方 null-this+Symbol() 用例)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ipo_false");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ipo_false");
        vm.label("_ipo_v_obj");
        // Step 2: ToObject(this). null/undefined this → TypeError.
        // S0 保持装箱(与 _object_getPrototypeOf 返回值做 SameValue);勿只认 __proto__@16——
        // Array(type=1)/Function/Proxy 布局不同,必须走 [[GetPrototypeOf]](即 gPO)。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_ipo_throw_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_ipo_throw_nullish");

        // ES: while (V = V.[[GetPrototypeOf]]) { if SameValue(V, O) return true } → false
        vm.label("_ipo_loop");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_getPrototypeOf"); // RET = next proto (boxed / null / undef)
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ipo_false");
        // x64: V0 is RET. Tag/payload scratch after gPO must be V5/V6, not V0 —
        // shrImm(V0, RET, 48) smashed the boxed proto to a tag, then mov S1,RET
        // walked a leftover tag → SIGSEGV (Object.prototype.isPrototypeOf({})).
        vm.shrImm(VReg.V5, VReg.RET, 48);
        vm.cmpImm(VReg.V5, 0x7FFA); // null
        vm.jeq("_ipo_false");
        vm.cmpImm(VReg.V5, 0x7FFB); // undefined(非标准类型无链)→ 终止
        vm.jeq("_ipo_false");
        // SameValue:装箱恒等,或裸 payload 恒等(gPO 偶返裸 classinfo)
        vm.cmp(VReg.RET, VReg.S0);
        vm.jeq("_ipo_true");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V5, VReg.RET, VReg.V1);
        vm.andMaskReg(VReg.V6, VReg.S0, VReg.V1);
        vm.cmp(VReg.V5, VReg.V6);
        vm.jeq("_ipo_true");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_ipo_loop");
        vm.label("_ipo_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_ipo_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_ipo_throw_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1], 16); // 理论不达
    }

    // Object.setPrototypeOf(obj, proto) -> obj; Reflect.setPrototypeOf -> boolean.
    // Both share [[SetPrototypeOf]], but Object throws when the internal operation returns false
    // while Reflect exposes that false result.  S2 is the mode (0=Object, 1=Reflect).
    generateSetPrototypeOf() {
        const vm = this.vm;

        vm.label("_reflect_setPrototypeOf");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm(VReg.S2, 1);
        vm.jmp("_ospo_entry");

        vm.label("_object_setPrototypeOf");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm(VReg.S2, 0);
        vm.label("_ospo_entry");
        vm.mov(VReg.S0, VReg.A0); // boxed obj(陷阱/返回须跨 call 保活)
        vm.mov(VReg.S1, VReg.A1); // boxed proto

        // Reflect requires an Object target (Object.setPrototypeOf merely
        // RequireObjectCoercible-coerces primitives and returns them unchanged).
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_ospo_target_ok");
        vm.shrImm(VReg.V5, VReg.S0, 48);
        vm.cmpImm(VReg.V5, 0x7FFD); vm.jeq("_ospo_target_ok");
        vm.cmpImm(VReg.V5, 0x7FFE); vm.jeq("_ospo_target_ok");
        vm.cmpImm(VReg.V5, 0x7FFF); vm.jeq("_ospo_target_ok");
        vm.cmpImm(VReg.V5, 0); vm.jne("_ospo_reflect_target_typeerr");
        vm.cmpImm(VReg.S0, 0); vm.jeq("_ospo_reflect_target_typeerr");
        vm.lea(VReg.V5, "_heap_base"); vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.S0, VReg.V5); vm.jlt("_ospo_reflect_target_typeerr");
        vm.lea(VReg.V5, "_heap_ptr"); vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.S0, VReg.V5); vm.jge("_ospo_reflect_target_typeerr");
        vm.loadByte(VReg.V5, VReg.S0, 0);
        vm.cmpImm(VReg.V5, TYPE_SYMBOL); vm.jeq("_ospo_reflect_target_typeerr");
        vm.label("_ospo_target_ok");

        // Type check: proto must be null or an Object (ES 19.1.2.18 step 3).
        // A0=obj (boxed), A1=proto (boxed). Same family as _object_create:
        // undefined is TypeError (not null); +0 is IEEE 0 / high16=0 and is a
        // number, not a raw heap pointer; TYPE_SYMBOL is Symbol not Object.
        // V5 tag/heap scratch (x64 V0≡RET).
        vm.shrImm(VReg.V5, VReg.A1, 48);
        vm.cmpImm(VReg.V5, 0x7FFA);        // null → ok
        vm.jeq("_ospo_type_ok");
        vm.cmpImm(VReg.V5, 0x7FFD);        // Object → ok
        vm.jeq("_ospo_type_ok");
        vm.cmpImm(VReg.V5, 0x7FFE);        // Array → ok
        vm.jeq("_ospo_type_ok");
        vm.cmpImm(VReg.V5, 0);             // raw heap pointer or +0
        vm.jne("_ospo_typeerr");
        vm.cmpImm(VReg.S1, 0);             // +0 → TypeError (same as _object_create)
        vm.jeq("_ospo_typeerr");
        vm.lea(VReg.V5, "_heap_base");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.S1, VReg.V5);
        vm.jlt("_ospo_typeerr");
        vm.lea(VReg.V5, "_heap_ptr");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.S1, VReg.V5);
        vm.jge("_ospo_typeerr");
        vm.loadByte(VReg.V5, VReg.S1, 0);
        vm.cmpImm(VReg.V5, TYPE_SYMBOL);
        vm.jeq("_ospo_typeerr");
        vm.jmp("_ospo_type_ok");
        vm.label("_ospo_typeerr");
        vm.lea(VReg.A0, vm.asm.addString("Object prototype may only be an Object or null"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        vm.label("_ospo_type_ok");
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
        // [proxy] [[SetPrototypeOf]] → handler.setPrototypeOf(target, proto)。
        // 与 seal/preventExtensions 同形:TYPE_PROXY=8 分派陷阱,抛则中断。
        // 禁止把 proto 写到 +16(那是 handler,不是 __proto__)。
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jne("_ospo_not_px");
        vm.mov(VReg.A0, VReg.V2);
        vm.lea(VReg.A1, this.vm.asm.addString("setPrototypeOf"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ospo_px_fwd");
        // Preserve the trap before assembling arguments: arm64 RET aliases A0,
        // while x64 A3 aliases V1.  V6 is not touched by the sequence below.
        vm.mov(VReg.V6, VReg.RET);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.load(VReg.A0, VReg.V2, 8); // target
        vm.mov(VReg.A1, VReg.S1);     // proto
        vm.lea(VReg.A2, "_js_undefined");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.mov(VReg.A3, VReg.V6);     // trap (last, after V1 scratch)
        vm.call("_aref_invoke_cb");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ospo_false");
        vm.jmp("_object_setPrototypeOf_done");
        vm.label("_ospo_px_fwd");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V1);
        vm.load(VReg.A0, VReg.V2, 8); // target
        vm.mov(VReg.A1, VReg.S1);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_ospo_px_fwd_object");
        vm.call("_reflect_setPrototypeOf");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_ospo_px_fwd_object");
        vm.call("_object_setPrototypeOf");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_ospo_not_px");
        // Object.prototype is the immutable-prototype exotic object.  Its current prototype is
        // permanently null: retaining null succeeds; every different value returns false.
        vm.lea(VReg.V0, "_nsobj_object_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        vm.cmp(VReg.V2, VReg.V0);
        vm.jne("_ospo_not_immutable_proto");
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_object_setPrototypeOf_done");
        vm.jmp("_ospo_false");
        vm.label("_ospo_not_immutable_proto");
        // Arrays store capacity at +16, not [[Prototype]]. Route their
        // prototype mutation through the array side table instead of corrupting
        // that header field.
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.cmpImm(VReg.V0, 1); // TYPE_ARRAY
        vm.jeq("_ospo_array");
        // OrdinarySetPrototypeOf on a non-extensible object may only retain
        // its current prototype; changing it must return false (the public
        // Object.setPrototypeOf wrapper then throws TypeError).
        vm.cmpImm(VReg.V0, TYPE_OBJECT);
        vm.jne("_ospo_cycle_check");
        vm.loadByte(VReg.V0, VReg.V2, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_NONEXT);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ospo_cycle_check");
        vm.load(VReg.V0, VReg.V2, 16);
        vm.cmp(VReg.V0, VReg.V3);
        vm.jeq("_object_setPrototypeOf_done");
        vm.jmp("_ospo_false");
        vm.label("_ospo_cycle_check");
        // [#T2] Cycle check: walk the proposed proto chain and reject if target
        // appears (OrdinarySetPrototypeOf step 7). Guard: proto is null (V3==0)
        // or target traversal depth exceeds 8192 → throw TypeError.
        // Proxy(TYPE_PROXY=8):handler@16 非 __proto__,跳遍历防段错误。
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_ospo_store");
        vm.loadByte(VReg.V0, VReg.V3, 0); // proposed proto 头类型
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jeq("_ospo_store");            // Proxy:handler@16,非 __proto__
        // 仅 TYPE_OBJECT/TYPE_CLOSURE 在 +16 存 __proto__。TA/Array/AB 等同址是
        // data_ptr/length 等 → 误遍历致 SIGSEGV(buffer/this-inherits-typedarray)。
        vm.cmpImm(VReg.V0, TYPE_OBJECT);
        vm.jeq("_ospo_cycle_start");
        vm.cmpImm(VReg.V0, 3);            // TYPE_CLOSURE(classinfo 同 JSObject 布局)
        vm.jeq("_ospo_cycle_start");
        vm.jmp("_ospo_store");
        vm.label("_ospo_cycle_start");
        vm.mov(VReg.V4, VReg.V3); // cursor = proposed proto
        vm.movImm64(VReg.V0, 0);  // depth counter
        vm.label("_ospo_cycle_loop");
        vm.cmp(VReg.V4, VReg.V2);  // cursor == target? → cycle
        vm.jeq("_ospo_cycle");
        // Stop as soon as the chain reaches an exotic [[GetPrototypeOf]]
        // implementation. In particular, a Proxy stores its handler at +16;
        // treating that field as an ordinary prototype pointer segfaults and
        // also violates OrdinarySetPrototypeOf step 7.c.i.
        vm.loadByte(VReg.V1, VReg.V4, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_ospo_cycle_load");
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_ospo_store");
        vm.label("_ospo_cycle_load");
        vm.load(VReg.V4, VReg.V4, 16); // cursor = cursor.__proto__
        vm.cmpImm(VReg.V4, 0);   // cursor == null? → ok
        vm.jeq("_ospo_store");
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.movImm64(VReg.V1, 8192);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_ospo_cycle_loop");
        // Depth exhausted or cycle detected → internal false.
        vm.label("_ospo_cycle");
        vm.jmp("_ospo_false");

        vm.label("_ospo_false");
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_ospo_reflect_false");
        vm.lea(VReg.A0, vm.asm.addString("Cannot set prototype of object: cycle detected or immutable prototype"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.label("_ospo_reflect_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_ospo_store");
        vm.store(VReg.V2, 16, VReg.V3);
        // [A2] 原型改写:保守形状置 0(键序未变;读侧形状只管自有键,置 0 无害)
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V2, OBJECT_SHAPE_OFFSET, VReg.V1);

        vm.label("_object_setPrototypeOf_done");
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_ospo_reflect_true");
        vm.mov(VReg.RET, VReg.S0); // 返回原始装箱 obj
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_ospo_reflect_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_ospo_array");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_array_set_instance_proto");
        vm.jmp("_object_setPrototypeOf_done");

        vm.label("_ospo_reflect_target_typeerr");
        vm.lea(VReg.A0, vm.asm.addString("Reflect.setPrototypeOf called on non-object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    // [__proto__] Object.prototype.__proto__ getter/setter
    // getter: this 在 A5(方法约定)。`_maybe_getter` 同时置 A0/A5;
    //   `Function.prototype.call` 蹦床只把 thisArg 放 A5、A0 为实参 → 必须读 A5
    //   (否则 get.call({}) 读到 A0=undefined → 假 null)。
    // setter: A0=newValue, A5=this(同 _object_set_acc_dispatch / .call)。
    generateProtoAccessor() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };

        // _object_proto_getter: ToObject(this) 后读 [[Prototype]](obj+16),装箱返回。
        vm.label("_object_proto_getter");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A5);        // S0 = boxed this(方法约定)
        // null/undefined this → TypeError(ToObject)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_proto_getter_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_proto_getter_nullish");
        // 委托 getPrototypeOf(装箱 this):覆盖 TYPE_OBJECT/+16、Array、Date 等
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_getPrototypeOf");
        vm.epilogue([VReg.S0], 16);

        vm.label("_proto_getter_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0], 16);

        // _object_proto_setter: B.2.2.1.2
        //   1 RequireObjectCoercible(this)  2 非 Object/Null proto → undefined
        //   3 非 Object this → undefined    4 [[SetPrototypeOf]](+cycle)
        //   5 status false → TypeError     6 return undefined
        vm.label("_object_proto_setter");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A5);        // S0 = boxed this
        vm.mov(VReg.S1, VReg.A0);        // S1 = new proto value (boxed)
        // RequireObjectCoercible(this)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_proto_setter_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_proto_setter_nullish");
        // proto 必须是 null 或 Object;否则返回 undefined(不抛,异于 setPrototypeOf)
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);      // null
        vm.jeq("_proto_setter_recv");
        vm.cmpImm(VReg.V0, 0x7FFD);      // Object
        vm.jeq("_proto_setter_recv");
        vm.cmpImm(VReg.V0, 0x7FFE);      // Array(亦 Object)
        vm.jeq("_proto_setter_recv");
        vm.cmpImm(VReg.V0, 0x7FFF);      // Function
        vm.jeq("_proto_setter_recv");
        vm.cmpImm(VReg.V0, 0);           // raw heap pointer candidate
        vm.jne("_proto_setter_done");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_proto_setter_done");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_proto_setter_done");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jge("_proto_setter_done");
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, TYPE_SYMBOL);
        vm.jeq("_proto_setter_done");
        vm.jmp("_proto_setter_recv");

        vm.label("_proto_setter_recv");
        // Type(O) 非 Object → 返回 undefined(基元 object-coercible)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_proto_setter_obj");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_proto_setter_obj");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_proto_setter_obj");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_proto_setter_done");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_proto_setter_done");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_proto_setter_done");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_proto_setter_done");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_SYMBOL);
        vm.jeq("_proto_setter_done");
        vm.jmp("_proto_setter_obj");

        vm.label("_proto_setter_obj");
        // Reuse the complete [[SetPrototypeOf]] implementation: Proxy traps
        // (and abrupt completion), same-prototype success on non-extensible
        // objects, cycle checks, and false→TypeError are all shared here.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_setPrototypeOf");
        vm.jmp("_proto_setter_done");
        // Debox;堆范围守卫
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1); // V0 = raw this
        vm.andMaskReg(VReg.V2, VReg.S1, VReg.V1); // V2 = raw proto (null → 0)
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_proto_setter_done");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_proto_setter_done");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_proto_setter_done");
        // 仅 TYPE_OBJECT 有标准 __proto__@16;其它布局静默 no-op → undefined
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jne("_proto_setter_done");
        // Non-extensible → TypeError([[SetPrototypeOf]] 返 false)
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_proto_setter_nonext");
        // Cycle check(镜像 _object_setPrototypeOf OrdinarySetPrototypeOf)
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_proto_setter_store");
        vm.load(VReg.V1, VReg.V2, 0);
        vm.andImm(VReg.V1, VReg.V1, 0xff);
        vm.cmpImm(VReg.V1, TYPE_PROXY);  // Proxy 无普通 proto 链,跳遍历
        vm.jeq("_proto_setter_store");
        vm.mov(VReg.V4, VReg.V2);        // cursor = proposed proto
        vm.movImm(VReg.V3, 0);           // depth
        vm.label("_proto_setter_cycle_loop");
        vm.cmp(VReg.V4, VReg.V0);        // cursor == O → cycle
        vm.jeq("_proto_setter_cycle");
        vm.loadByte(VReg.V1, VReg.V4, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jne("_proto_setter_store");  // 非 ordinary → 停(规范 done=true)
        vm.load(VReg.V4, VReg.V4, 16);   // cursor = cursor.[[Prototype]]
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_proto_setter_store");
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.cmpImm(VReg.V3, 8192);
        vm.jlt("_proto_setter_cycle_loop");
        vm.label("_proto_setter_cycle");
        vm.lea(VReg.A0, vm.asm.addString("Cannot set prototype of object: cycle detected"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");

        vm.label("_proto_setter_store");
        vm.store(VReg.V0, 16, VReg.V2);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, OBJECT_SHAPE_OFFSET, VReg.V1);
        vm.label("_proto_setter_done");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_proto_setter_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_proto_setter_nonext");
        vm.lea(VReg.A0, vm.asm.addString("#<Object> is not extensible"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // [test262] %ThrowTypeError% 落点:Function.prototype.caller / .arguments 的
        // getter+setter 共用(ES 18.2.1.1.3)——无论读写一律抛 TypeError。调用方
        // (_maybe_getter / _object_set_acc_dispatch)经 callIndirect 以 (A0=A5=this,
        // argc=0/1) 进入;直接抛、永不返回,无需 prologue/epilogue。
        vm.label("_fp_throw_accessor");
        vm.lea(VReg.A0, vm.asm.addString("'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");

        vm.asm.registerRuntimeString("_str_proto_key", "__proto__");
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

    // [底层A W-A2] _object_ctor_call - 裸 `Object` 作值调用(如 `var O=Object; O(x)`)。
    // 规范:Object(...) 无 new 合法(返回 ToObject(x) 包装)。本入口保守抛 "requires 'new'"
    // (同 Array/Map/Set 模式)——`new Object(...)` 的静态特判(compileNewExpression case
    // "Object" → 空对象)与 `Object.method(...)` 静态改派先于值路径命中不经此;值路径
    // 调用属边缘用例,列偏差(ToObject 包装未实现)。
    generateObjectCtorCall() {
        const vm = this.vm;
        vm.label("_object_ctor_call");
        vm.prologue(0, []);
        // When Construct(Object, args, NewTarget) has a distinct NewTarget,
        // _fn_construct_call has already allocated the correct instance from
        // NewTarget.prototype. Do not override it with an Object.prototype
        // instance returned by this active-function body.
        vm.lea(VReg.V0, "_call_new_target");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_oct_call_default");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_oct_call_default");
        vm.lea(VReg.V1, "_nsobj_object");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_oct_call_default");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
        vm.label("_oct_call_default");
        // Construct(Object)/Object():空对象。ToObject 包装(Object(5)→Number)仍偏差。
        // 旧实现一律 TypeError,令 Array.from.call(Object, []) 无法 Construct。
        vm.call("_object_new");
        vm.call("_box_obj_r");
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

    // SetIntegrityLevel for Proxy objects. A0=proxy, A1=0(sealed)/1(frozen).
    // The key list is snapshotted exactly once. Seal sends only
    // {configurable:false}; freeze first observes the current descriptor and
    // additionally sends writable:false for data properties. These deliberately
    // remain partial descriptor objects because the shape is observable in the
    // defineProperty trap.
    generateObjectSetIntegrityLevel() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
            vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(reg, reg, VReg.V1);
        };

        vm.label("_object_set_integrity_proxy");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // proxy
        vm.store(VReg.SP, 8, VReg.A1); // level

        // SetIntegrityLevel step 3. Object.freeze/seal require false → TypeError;
        // _object_preventExtensions supplies that wrapper semantic.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_preventExtensions");

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_all_own_keys");
        vm.mov(VReg.S1, VReg.RET); // one validated [[OwnPropertyKeys]] snapshot
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_osip_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_osip_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET); // key
        vm.movImm(VReg.V0, 0); // isAccessor=false (seal does not inspect)
        vm.store(VReg.SP, 24, VReg.V0);

        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_osip_make_desc");
        // frozen: currentDesc = ? O.[[GetOwnProperty]](key); absent keys skip.
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.mov(VReg.S5, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S5, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_osip_next");
        vm.mov(VReg.A0, VReg.S5);
        vm.lea(VReg.A1, vm.asm.addString("get"));
        boxStr(VReg.A1);
        vm.call("_object_has");
        vm.store(VReg.SP, 24, VReg.RET); // completed accessor desc has own "get"

        vm.label("_osip_make_desc");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.store(VReg.SP, 0, VReg.RET); // partial descriptor
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("configurable"));
        boxStr(VReg.A1);
        vm.lea(VReg.A2, "_js_false");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.call("_object_set");

        vm.load(VReg.V0, VReg.SP, 8);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_osip_define"); // sealed: configurable only
        vm.load(VReg.V0, VReg.SP, 24);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_osip_define"); // frozen accessor: configurable only
        vm.load(VReg.A0, VReg.SP, 0);
        vm.lea(VReg.A1, vm.asm.addString("writable"));
        boxStr(VReg.A1);
        vm.lea(VReg.A2, "_js_false");
        vm.load(VReg.A2, VReg.A2, 0);
        vm.call("_object_set");

        vm.label("_osip_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.call("_object_defineProperty_proxy_or_throw");
        vm.label("_osip_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_osip_loop");
        vm.label("_osip_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
    }

    // Object.freeze(obj) -> obj(原对象)。对象级全冻(P1 位保留:FROZEN|SEALED|NONEXT)
    // + [P2] 精确:materialize flags 并对全属性清 writable|configurable(getOwnProperty-
    // Descriptor 可读回 writable:false)。对象级 FROZEN 在 _object_set 仍先行短路。
    // Array/Arguments(0x7FFE):byte1 置 FROZEN|SEALED|NONEXT(bit0≡length 不可写,符合
    // freeze),并 freeze 闭包侧表(具名属性 attrs)。函数(0x7FFF):闭包无对象头 byte1,
    // integrity 落侧表 props 对象(ensure 后 freeze props)。
    generateObjectFreeze() {
        const vm = this.vm;
        vm.label("_object_freeze");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0); // boxed receiver(返回值)
        // Proxy SetIntegrityLevel is fully observable; dispatch before the
        // compact ordinary/exotic fast paths.
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_ofrz_px_heap");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_ofrz_not_px");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_ofrz_not_px");
        vm.label("_ofrz_px_heap");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_ofrz_not_px");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jne("_ofrz_not_px");
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.call("_object_set_integrity_proxy");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_ofrz_not_px");
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_ofrz_arr");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_ofrz_fn");
        // TypedArray + resizable ArrayBuffer:SetIntegrityLevel → TypeError
        // (含 length=0 / length-tracking)。内联 buffer@24==0 或 maxByteLength=-1 不抛。
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ofrz_ta_ck");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_ofrz_not_ta");
        vm.label("_ofrz_ta_ck");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V0);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_ofrz_not_ta");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_TA_LO);
        vm.jlt("_ofrz_not_ta");
        vm.cmpImm(VReg.V1, TYPE_TA_HI);
        vm.jgt("_ofrz_not_ta");
        vm.load(VReg.V1, VReg.V0, 24); // buffer@24
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ofrz_not_ta");
        vm.loadByte(VReg.V2, VReg.V1, 0);
        vm.cmpImm(VReg.V2, TYPE_ARRAY_BUFFER);
        vm.jne("_ofrz_not_ta");
        vm.load(VReg.V2, VReg.V1, 32); // maxByteLength(-1 = 不可 resize)
        vm.cmpImm(VReg.V2, 0);
        vm.jlt("_ofrz_not_ta");
        vm.lea(VReg.A0, vm.asm.addString("Cannot freeze a TypedArray backed by a resizable ArrayBuffer"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_ofrz_not_ta");
        // Date keeps user properties in the shared side table. Freeze both the
        // compact instance header and that ordinary backing object.
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_ofrz_not_date");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V1);
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jne("_ofrz_not_date");
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.orImm(VReg.V1, VReg.V1, EXT_FROZEN | EXT_SEALED | EXT_NONEXT);
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ofrz_ret");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_freeze");
        vm.jmp("_ofrz_ret");
        vm.label("_ofrz_not_date");
        vm.mov(VReg.A0, VReg.S1);
        this._extGuard("_ofrz", "_ofrz_ret");
        vm.mov(VReg.S0, VReg.V0); // raw obj
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.orImm(VReg.V1, VReg.V1, EXT_FROZEN | EXT_SEALED | EXT_NONEXT);
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, ATTR_WRITABLE | ATTR_CONFIGURABLE);
        vm.call("_object_apply_clear_attrs");
        vm.jmp("_ofrz_ret");
        // ---- Array / Arguments ----
        vm.label("_ofrz_arr");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_ofrz_ret");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jne("_ofrz_ret");
        vm.loadByte(VReg.V1, VReg.S0, 1);
        // FROZEN|SEALED|NONEXT; bit0 同时 = ARR_LEN_NONWRITABLE(freeze 后 length 不可写)
        vm.orImm(VReg.V1, VReg.V1, EXT_FROZEN | EXT_SEALED | EXT_NONEXT | EXT_ARRAY_SEALED);
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ofrz_ret");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_freeze"); // 递归:侧表是 TYPE_OBJECT
        vm.jmp("_ofrz_ret");
        // ---- Function ----
        vm.label("_ofrz_fn");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_closure_props_ensure");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_freeze");
        vm.label("_ofrz_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Object.seal(obj) -> obj。对象级 SEALED|NONEXT + [P2] 精确:清全属性 configurable
    // (writable 保留,可改写已有值)。
    // Array:置 EXT_ARRAY_SEALED|EXT_NONEXT(不置 FROZEN;bit0 与 length 可写同位——
    // preventExtensions 既有同形偏差,seal 沿用)。侧表 seal。函数:ensure+seal 侧表。
    generateObjectSeal() {
        const vm = this.vm;
        vm.label("_object_seal");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0);
        // [proxy] SetIntegrityLevel → [[PreventExtensions]]。_object_preventExtensions
        // 已分派 preventExtensions 陷阱;此处复用,陷阱抛则 Object.seal 中断。
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_osl_px_heap");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_osl_not_px");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_osl_not_px");
        vm.label("_osl_px_heap");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V1);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_osl_not_px");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_osl_not_px");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_PROXY);
        vm.jne("_osl_not_px");
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_object_set_integrity_proxy");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_osl_not_px");
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_osl_arr");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_osl_fn");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_osl_not_date");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V1);
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jne("_osl_not_date");
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.orImm(VReg.V1, VReg.V1, EXT_SEALED | EXT_NONEXT);
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_osl_ret");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_seal");
        vm.jmp("_osl_ret");
        vm.label("_osl_not_date");
        this._extGuard("_osl", "_osl_ret");
        vm.mov(VReg.S0, VReg.V0);
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.orImm(VReg.V1, VReg.V1, EXT_SEALED | EXT_NONEXT);
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, ATTR_CONFIGURABLE);
        vm.call("_object_apply_clear_attrs");
        vm.jmp("_osl_ret");
        vm.label("_osl_arr");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_osl_ret");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 1);
        vm.jne("_osl_ret");
        vm.loadByte(VReg.V1, VReg.S0, 1);
        // EXT_ARRAY_SEALED(bit4) 与 ARR_HAS_SIDETABLE(bit1) 正交,isSealed 可靠
        vm.orImm(VReg.V1, VReg.V1, EXT_ARRAY_SEALED | EXT_NONEXT);
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_osl_ret");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_seal");
        vm.jmp("_osl_ret");
        vm.label("_osl_fn");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_closure_props_ensure");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_seal");
        vm.label("_osl_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // Object.preventExtensions(obj) -> obj。| NONEXT(仅拒新增,可改写/可删)。
    // [proxy] proxy 有 preventExtensions 陷阱则 handler.preventExtensions(target),否则
    // 转发 target(不变式检查——陷阱返 true 但 target 仍可扩展应抛——推迟)。
    // 函数(0x7FFF): integrity 落侧表 props(ensure + 递归,同 freeze/seal)。
    // classinfo(type@0==3,裸或 0x7FFD 装箱):布局同对象头,byte1 |= EXT_NONEXT。
    // 使 static #g = (preventExtensions(Class), v) 的 _object_define TypeError。
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
        vm.jeq("_opx_px_false");
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
        vm.label("_opx_px_false");
        vm.lea(VReg.A0, vm.asm.addString("Proxy preventExtensions trap returned false"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_opx_proxy_fwd");
        vm.load(VReg.A0, VReg.S1, 8); // target
        vm.call("_object_preventExtensions");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        // 普通对象路径(+ Array/Date:byte1 与对象 EXT_* 同位)
        vm.label("_opx_normal");
        vm.mov(VReg.A0, VReg.S0);
        // 扩展 _extGuard:Array(1)/Date(7) 亦受理(arguments 亦 TYPE_ARRAY)
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_opx_ds");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_opx_ds");
        vm.cmpImm(VReg.V1, 0x7FFE); // Array 装箱
        vm.jeq("_opx_ds");
        vm.cmpImm(VReg.V1, 0x7FFF); // 函数闭包: integrity 落侧表(同 freeze/seal)
        vm.jeq("_opx_fn");
        vm.jmp("_opx_ret"); // 原语 → 返原值(ES:ToObject 后操作)
        // 0x7FFF: ensure 侧表后 preventExtensions(props)。PrivateFieldAdd / 具名
        // 属性写走 _closure_prop_define → _object_define(props) → byte1 NONEXT TypeError。
        vm.label("_opx_fn");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_ensure");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_preventExtensions");
        vm.jmp("_opx_ret");
        vm.label("_opx_ds");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_opx_ret");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_opx_setbit");
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY(含 arguments)
        vm.jeq("_opx_setbit");
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jeq("_opx_setbit");
        vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION / classinfo(布局同对象头)
        vm.jeq("_opx_setbit");
        vm.jmp("_opx_ret");
        vm.label("_opx_setbit");
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
    // Array/Arguments:先前 0x7FFE 误落「原语 → true」,preventExtensions(arguments)
    // 后 isFrozen 恒 true(15.2.3.12-2-a-11)。现按 EXT_FROZEN / 空+NONEXT 判别。

    // TestIntegrityLevel(O, level). A0=obj, A1=0 sealed / 1 frozen.
    // Used by isFrozen/isSealed on TYPE_PROXY (own table is target@8, not props).
    generateObjectTestIntegrity() {
        const vm = this.vm;
        vm.label("_object_test_integrity");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.store(VReg.SP, 8, VReg.A1); // level
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_isExtensible");
        vm.lea(VReg.V2, "_js_true");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.RET, VReg.V2);
        vm.jeq("_oti_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_all_own_keys");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_oti_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_oti_true");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.lea(VReg.V2, "_js_undefined");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.RET, VReg.V2);
        vm.jeq("_oti_next");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.lea(VReg.A0, vm.asm.addString("configurable"));
        vm.call("_cstr_to_heap_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_oti_false");
        vm.load(VReg.V2, VReg.SP, 8);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_oti_next");
        vm.lea(VReg.A0, vm.asm.addString("writable"));
        vm.call("_cstr_to_heap_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_oti_false");
        vm.label("_oti_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_oti_loop");
        vm.label("_oti_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
        vm.label("_oti_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);
    }

    generateObjectIsFrozen() {
        const vm = this.vm;
        vm.label("_object_isFrozen");
        vm.prologue(0, []);
        // ES 19.1.2.12: primitives → true, objects check EXT_FROZEN bit
        // Functions (0x7FFF) are objects → check frozen status
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0); // 裸堆指针
        vm.jeq("_ifz_ds");
        vm.cmpImm(VReg.V1, 0x7FFD); // 装箱对象
        vm.jeq("_ifz_ds");
        vm.cmpImm(VReg.V1, 0x7FFE); // Array / Arguments
        vm.jeq("_ifz_arr");
        vm.cmpImm(VReg.V1, 0x7FFF); // 函数值(也是对象)
        vm.jeq("_ifz_fn");
        // 非对象(原语) → true
        vm.label("_ifz_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
        // Array/Arguments:EXT_FROZEN → true;NONEXT∧length==0∧侧表空/frozen → vacuously;
        // 否则 false(preventExtensions 后仍有可写元素 → 非 frozen)。
        vm.label("_ifz_arr");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_ifz_true");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 1);
        vm.jne("_ifz_true");
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V3, VReg.V1, EXT_FROZEN);
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_ifz_true");
        vm.andImm(VReg.V3, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_ifz_false");
        vm.load(VReg.V3, VReg.V0, 8); // length
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_ifz_false"); // 有元素且未 freeze → 非 frozen
        // length==0 + NONEXT:侧表有具名属性则看 props.isFrozen,否则 vacuously true
        // A0 仍为原 boxed arr(andMaskReg 只写 V0)
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ifz_true");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_isFrozen");
        vm.epilogue([], 0);
        // 函数:integrity 在侧表 props(freeze 时 ensure+freeze props)。
        vm.label("_ifz_fn");
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ifz_false"); // 无侧表 → 未 freeze
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_isFrozen");
        vm.epilogue([], 0);
        vm.label("_ifz_ds");
        // TYPE_PROXY: TestIntegrityLevel (ownKeys + gOPD). TYPE_REGEXP===8:
        // handler@16 is flags (small int) — skip, keep EXT path.
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_ifz_true");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jne("_ifz_ds_obj");
        vm.load(VReg.V2, VReg.V0, 16);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_ifz_proxy_ok");
        vm.shrImm(VReg.V1, VReg.V2, 48);
        vm.cmpImm(VReg.V1, 0x7FFA); vm.jeq("_ifz_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFB); vm.jeq("_ifz_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFD); vm.jeq("_ifz_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFE); vm.jeq("_ifz_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFF); vm.jeq("_ifz_proxy_ok");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_ifz_ds_obj");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_ifz_ds_obj");
        vm.label("_ifz_proxy_ok");
        vm.movImm(VReg.A1, 1);
        vm.call("_object_test_integrity");
        vm.epilogue([], 0);
        vm.label("_ifz_ds_obj");
        // Flags are only a fast mutation guard, not proof of integrity: users
        // can manually make every property non-writable/non-configurable and
        // then prevent extensions. Run the actual TestIntegrityLevel for
        // ordinary objects/classinfo and Date side-table exotics.
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_ifz_test");
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_ifz_test");
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jne("_ifz_true");
        vm.label("_ifz_test");
        vm.movImm(VReg.A1, 1);
        vm.call("_object_test_integrity");
        vm.epilogue([], 0);
        vm.label("_ifz_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
    }

    // Object.isSealed(obj) -> js_true/js_false。
    // sealed ⟺ EXT_SEALED 位;边角同 isFrozen:空对象 + non-extensible → true。
    // 非对象接收者 → true。
    // Array:用 EXT_FROZEN|EXT_ARRAY_SEALED(不信 bit1≡ARR_HAS_SIDETABLE)。
    // 函数:侧表 props.isSealed。
    generateObjectIsSealed() {
        const vm = this.vm;
        vm.label("_object_isSealed");
        vm.prologue(0, []);
        // ES 19.1.2.13: primitives → true, objects check EXT_SEALED bit
        // Functions (0x7FFF) are objects → check sealed status
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_isl_ds");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_isl_ds");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_isl_arr");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_isl_fn");
        // 非对象(原语) → true
        vm.label("_isl_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
        vm.label("_isl_arr");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_isl_true");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 1);
        vm.jne("_isl_true");
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V3, VReg.V1, EXT_FROZEN | EXT_ARRAY_SEALED);
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_isl_true");
        vm.andImm(VReg.V3, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_isl_false");
        vm.load(VReg.V3, VReg.V0, 8); // length
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_isl_false"); // 有元素且未 seal/freeze → 非 sealed
        vm.call("_closure_props_find"); // A0 仍为 boxed arr
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_isl_true");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_isSealed");
        vm.epilogue([], 0);
        vm.label("_isl_fn");
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_isl_false");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_isSealed");
        vm.epilogue([], 0);
        vm.label("_isl_ds");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_isl_true");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jne("_isl_ds_obj");
        vm.load(VReg.V2, VReg.V0, 16);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_isl_proxy_ok");
        vm.shrImm(VReg.V1, VReg.V2, 48);
        vm.cmpImm(VReg.V1, 0x7FFA); vm.jeq("_isl_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFB); vm.jeq("_isl_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFD); vm.jeq("_isl_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFE); vm.jeq("_isl_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFF); vm.jeq("_isl_proxy_ok");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_isl_ds_obj");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_isl_ds_obj");
        vm.label("_isl_proxy_ok");
        vm.movImm(VReg.A1, 0);
        vm.call("_object_test_integrity");
        vm.epilogue([], 0);
        vm.label("_isl_ds_obj");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_isl_test");
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_isl_test");
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jne("_isl_true");
        vm.label("_isl_test");
        vm.movImm(VReg.A1, 0);
        vm.call("_object_test_integrity");
        vm.epilogue([], 0);
        vm.label("_isl_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([], 0);
    }

    // Object.isExtensible(obj) -> js_true/js_false。
    // extensible ⟺ (byte1 & EXT_NONEXT)==0。非对象接收者(primitive)→ false。
    // 函数:侧表 props 的 EXT_NONEXT(seal/freeze/preventExtensions 经 props 落位)。
    // Proxy: GetMethod(handler, "isExtensible"); present-not-callable → TypeError;
    // 无陷阱 → target.[[IsExtensible]](); 有陷阱 → ToBoolean + SameValue(target)。
    generateObjectIsExtensible() {
        const vm = this.vm;
        vm.label("_object_isExtensible");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        // ES 19.1.2.5: primitives → false, objects check EXT_NONEXT bit
        // Functions (0x7FFF) are objects → extensible == not sealed/frozen
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_iex_ds");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_iex_ds");
        vm.cmpImm(VReg.V1, 0x7FFE); // Array / arguments
        vm.jeq("_iex_ds");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_iex_fn");
        // 非对象(原语) → false
        vm.label("_iex_false");
        vm.lea(VReg.RET, "_js_false");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        // 函数:侧表 props 带 NONEXT → false;无侧表 → true(可扩展)
        vm.label("_iex_fn");
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_iex_fn_true");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_object_isExtensible");
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_iex_fn_true");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_iex_ds");
        // Array/Date/普通对象:byte1 & EXT_NONEXT(arguments≡TYPE_ARRAY)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_iex_false");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROXY);
        vm.jeq("_iex_proxy");
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_iex_check");
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jeq("_iex_check");
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jeq("_iex_check");
        vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION / classinfo
        vm.jeq("_iex_check");
        vm.jmp("_iex_false"); // 其它堆块(Map/Promise…)暂 false
        vm.label("_iex_check");
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, EXT_NONEXT);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_iex_false");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        // [[IsExtensible]]: GetMethod + trap / forward. x64: V2 for js_true (V0≡RET).
        // TYPE_REGEXP === 8 === TYPE_PROXY: handler@16 is flags (small int), not an
        // object. Do not call _proxy_trap_fn (Get on flags=1 hangs). Use EXT_NONEXT.
        vm.label("_iex_proxy");
        vm.mov(VReg.S0, VReg.V0); // raw
        vm.load(VReg.V2, VReg.S0, 16); // handler or regexp flags
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_iex_proxy_ok"); // revoked handler=0 → _proxy_trap_fn TypeError
        vm.shrImm(VReg.V1, VReg.V2, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_iex_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_iex_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_iex_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_iex_proxy_ok");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_iex_proxy_ok");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_iex_check"); // unexpected tag → ordinary EXT_NONEXT
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_iex_check"); // nonzero small-int flags → RegExp
        vm.label("_iex_proxy_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, this.vm.asm.addString("isExtensible"));
        vm.call("_proxy_trap_fn");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_iex_proxy_fwd");
        vm.mov(VReg.A3, VReg.RET);
        vm.load(VReg.A0, VReg.S0, 8); // target
        vm.lea(VReg.A1, "_js_undefined");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.mov(VReg.A2, VReg.A1);
        vm.load(VReg.A4, VReg.S0, 16); // this = handler (Call(trap, handler, «target»))
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean"); // RET = 0/1
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_object_isExtensible");
        vm.lea(VReg.V2, "_js_true");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.cmp(VReg.RET, VReg.V2);
        vm.jeq("_iex_px_tgt_true");
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_iex_px_inv");
        vm.jmp("_iex_false");
        vm.label("_iex_px_tgt_true");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_iex_px_inv");
        vm.lea(VReg.RET, "_js_true");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_iex_px_inv");
        vm.lea(VReg.A0, vm.asm.addString("proxy invariant violation"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_iex_proxy_fwd");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_object_isExtensible");
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // Object.is(a, b) -- SameValue runtime helper for value-call path.
    // The compiler inline-expands Object.is(...) for static call sites; this
    // function handles the memoized-ref path (e.g. var f=Object.is; f(a,b)).
    generateObjectIsValue() {
        const vm = this.vm;
        vm.label("_object_is_value");
        // SameValue algorithm:
        //   If typeof a !== typeof b, return false (handled by === below for
        //   different box tags; +0/-0 and NaN special-cased)
        //   If a === b: a !== 0 || 1/a === 1/b (handles +0/-0)
        //   Else: a !== a && b !== b (both NaN)
        // Strategy: compare A0, A1 as 64-bit integers. SameValue differs from
        // strict equality only on NaN and signed zero. Number values are stored
        // as IEEE754 float64 in the low 48 bits (NaN-boxed). Compare bits directly.
        vm.mov(VReg.V0, VReg.A0);
        vm.cmp(VReg.A0, VReg.A1);
        vm.jne("_ois_notsame");
        // bits equal: could be null/undefined/bool/string/obj or same number.
        // Check for +0: if value === 0 (boxed), return true (SameValue(+0,+0)=true)
        // Actually SameValue(0, -0) = false. But if bits are equal, it can't be +0 vs -0.
        vm.movImm64(VReg.RET, 0x7ff9000000000001n); // true
        vm.epilogue([], 0);
        vm.label("_ois_notsame");
        // Not strictly equal. Could be NaN/NaN (should be true) or +0/-0 (should be false).
        // Check if both are numbers (tag 0 or 0x7FF8).
        // For boxed values with tag 0x7FF8, compare bits for NaN detection.
        vm.shrImm(VReg.V2, VReg.A0, 48);
        vm.shrImm(VReg.V3, VReg.A1, 48);
        // NaN: high16 is 0x7FF8 (or 0x7FF0 print-friendly). Both must be NaN-tagged.
        vm.cmpImm(VReg.V2, 0x7FF8);
        vm.jne("_ois_nonan");
        vm.cmpImm(VReg.V3, 0x7FF8);
        vm.jne("_ois_nonan");
        // Both NaN → SameValue is true
        vm.movImm64(VReg.RET, 0x7ff9000000000001n); // true
        vm.epilogue([], 0);
        vm.label("_ois_nonan");
        // Check for +0/-0: tag is 0x7FF8 and value bits are all zero (except sign bit for -0)
        // Actually JS numbers are stored as IEEE754 in low 48 bits. -0 has sign bit set.
        // But since we already checked for bit equality above, if they differ, one is +0,
        // the other is -0 → SameValue = false.
        // Also check for NaN variations (0x7FF8 with different payload bits): SameValue = true.
        // Since both have 0x7FF8 tag, check if both are NaN (exponent all 1s, mantissa non-zero).
        // Simplified: if both are numbers and differ, and neither is NaN, it's a normal
        // non-equal comparison → false (already handled by cmp+jne at top).
        vm.movImm64(VReg.RET, 0x7ff9000000000000n); // false
        vm.epilogue([], 0);
    }

    // Object.fromEntries(entries) -- AddEntriesFromIterable with CreateDataProperty semantics.
    // Entry processing is interleaved with iterator advancement; entry/coercion/define abrupt
    // completions close the iterator, while IteratorStep failures do not.
    generateObjectFromEntries() {
        const vm = this.vm;
        vm.label("_object_fromEntries");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);  // iterable
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S1, VReg.RET);

        // GetIterator(iterable), with intrinsic Array/String fallback for runtime-only methods.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_get_method_iterator");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ofe_default_iterator");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_spread_call0");
        vm.jmp("_ofe_check_iterator");

        vm.label("_ofe_default_iterator");
        // Present own undefined @@iterator suppresses the intrinsic fallback.
        vm.lea(VReg.A0, "_symwk_iterator");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ofe_not_iterable");
        vm.shrImm(VReg.V3, VReg.S0, 48);
        vm.cmpImm(VReg.V3, 0x7FFE);
        vm.jne("_ofe_default_string");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V3, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V3, VReg.V3, 0);
        vm.cmpImm(VReg.V3, 1);
        vm.jne("_ofe_not_iterable");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_iterator_new");
        vm.jmp("_ofe_check_iterator");
        vm.label("_ofe_default_string");
        vm.cmpImm(VReg.V3, 0x7FFC);
        vm.jne("_ofe_not_iterable");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_iterator_new");

        vm.label("_ofe_check_iterator");
        vm.shrImm(VReg.V3, VReg.RET, 48);
        vm.cmpImm(VReg.V3, 0x7FFD); vm.jeq("_ofe_iterator_ok");
        vm.cmpImm(VReg.V3, 0x7FFE); vm.jeq("_ofe_iterator_ok");
        vm.cmpImm(VReg.V3, 0x7FFF); vm.jne("_ofe_bad_iterator");
        vm.label("_ofe_iterator_ok");
        vm.mov(VReg.S2, VReg.RET); // iterator

        vm.label("_ofe_loop");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_maybe_getter");
        vm.store(VReg.SP, 24, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ofe_bad_next");
        vm.load(VReg.A0, VReg.SP, 24);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_spread_call0");
        vm.mov(VReg.S3, VReg.RET); // iterator result
        vm.shrImm(VReg.V3, VReg.S3, 48);
        vm.cmpImm(VReg.V3, 0x7FFD); vm.jeq("_ofe_result_ok");
        vm.cmpImm(VReg.V3, 0x7FFE); vm.jeq("_ofe_result_ok");
        vm.cmpImm(VReg.V3, 0x7FFF); vm.jne("_ofe_bad_result");
        vm.label("_ofe_result_ok");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("done"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_maybe_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ofe_done");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_maybe_getter");
        vm.mov(VReg.S3, VReg.RET); // entry

        // From Type(entry) through CreateDataProperty, abrupt completion closes iterator.
        vm.lea(VReg.V1, "_exc_ctx_top"); vm.load(VReg.V2, VReg.V1, 0);
        vm.store(VReg.SP, 32, VReg.V2);
        vm.lea(VReg.V2, "_ofe_catch"); vm.store(VReg.SP, 40, VReg.V2);
        vm.mov(VReg.V2, VReg.SP); vm.store(VReg.SP, 48, VReg.V2);
        vm.store(VReg.SP, 56, VReg.FP);
        vm.store(VReg.SP, 64, VReg.S0); vm.store(VReg.SP, 72, VReg.S1);
        vm.store(VReg.SP, 80, VReg.S2); vm.store(VReg.SP, 88, VReg.S3);
        vm.store(VReg.SP, 96, VReg.S4); vm.store(VReg.SP, 104, VReg.S5);
        vm.addImm(VReg.V2, VReg.SP, 32);
        vm.lea(VReg.V1, "_exc_ctx_top"); vm.store(VReg.V1, 0, VReg.V2);

        vm.shrImm(VReg.V3, VReg.S3, 48);
        vm.cmpImm(VReg.V3, 0x7FFD); vm.jeq("_ofe_entry_ok");
        vm.cmpImm(VReg.V3, 0x7FFE); vm.jeq("_ofe_entry_ok");
        vm.cmpImm(VReg.V3, 0x7FFF); vm.jne("_ofe_bad_entry");
        vm.label("_ofe_entry_ok");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("0"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S3); vm.call("_maybe_getter");
        vm.store(VReg.SP, 0, VReg.RET); // raw key; ToPropertyKey follows both Gets
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("1"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S3); vm.call("_maybe_getter");
        vm.store(VReg.SP, 8, VReg.RET); // value
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_js_prop_key");
        vm.store(VReg.SP, 0, VReg.RET); // normalized property key
        vm.load(VReg.A2, VReg.SP, 8);
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_define"); // CreateDataProperty: never invokes inherited setters
        vm.load(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top"); vm.store(VReg.V0, 0, VReg.V1);
        vm.jmp("_ofe_loop");

        vm.label("_ofe_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);

        vm.label("_ofe_catch");
        vm.load(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top"); vm.store(VReg.V0, 0, VReg.V1);
        vm.mov(VReg.A0, VReg.S2); vm.call("_iterator_close_keep"); vm.call("_throw_unwind");

        const ofeThrow = (label, message) => {
            vm.label(label);
            vm.lea(VReg.A0, vm.asm.addString(message));
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
            vm.call("_throw_type_error");
        };
        ofeThrow("_ofe_not_iterable", "object is not iterable");
        ofeThrow("_ofe_bad_iterator", "Result of iterator method is not an object");
        ofeThrow("_ofe_bad_next", "iterator next is not callable");
        ofeThrow("_ofe_bad_result", "iterator result is not an object");
        ofeThrow("_ofe_bad_entry", "Iterator value is not an entry object");
    }

    // Object.defineProperties(obj, props) -- runtime fallback for value-call path.
    // The compiler desugars static call sites to a sequence of defineProperty calls;
    // this helper handles the memoized-ref path by iterating Object.keys(props) and
    // calling _object_define_property_dyn for each key.
    generateObjectDefinePropertiesDyn() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_object_define_properties_dyn");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);  // obj
        vm.mov(VReg.S1, VReg.A1);  // props
        // Receiver must be an Object (not ToObject-coercible).  Reuse the
        // strict descriptor-object classifier so raw Symbol/BigInt/zero do not
        // masquerade as heap pointers.
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_dp_require_object");
        vm.label("_odps_recv_ok");
        // ObjectDefineProperties snapshots the complete [[OwnPropertyKeys]]
        // list, then consults each own descriptor's enumerable bit.  This is
        // observable for Proxy and includes Symbol keys.
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_all_own_keys");
        vm.mov(VReg.S2, VReg.RET); // keys array
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_length");
        vm.mov(VReg.S3, VReg.RET); // len
        vm.movImm(VReg.S4, 0);     // i
        vm.label("_odps_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_odps_done");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");     // key
        vm.mov(VReg.S5, VReg.RET); // key boxed (S5 callee-saved, survives calls)
        // propDesc = props.[[GetOwnProperty]](key); absent/non-enumerable keys
        // are skipped without performing Get(props, key).
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_odps_next");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("enumerable"));
        boxStr(VReg.A1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_odps_next");
        // Read descriptor from props[key] — [[Get]] 须触发访问器并以 props 为 this
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_object_get");    // RET = desc 或 TYPE_GETTER 标记
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);  // this = props(装箱)
        vm.call("_maybe_getter");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_object_define_property_dyn");
        vm.label("_odps_next");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_odps_loop");
        vm.label("_odps_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // _object_define_properties_recv_check(A0=obj):静态 defineProperties 脱糖入口校验。
        // 与 _odps_recv_ok 同判据;原语 → TypeError(不返回)。
        vm.label("_object_define_properties_recv_check");
        vm.prologue(0, []);
        vm.call("_dp_require_object");
        vm.label("_odps_chk_ok");
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
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY: named properties live in the side table
        vm.jeq("_ospa_array_side");
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_ospa_type_ok");
        vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION (classinfo) — same layout as TYPE_OBJECT
        vm.jne("_ospa_done");
        vm.label("_ospa_type_ok");
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
        vm.jmp("_ospa_done");
        // Array headers do not contain an ordinary object's props/flags fields.
        // Named and Symbol properties (including methods on the real
        // Array.prototype exotic) are stored in the per-array side-table
        // object, so apply the attribute to that ordinary object instead.
        vm.label("_ospa_array_side");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ospa_done");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set_prop_attr");
        vm.label("_ospa_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // [#dp-mask] defineProperty 验证/强制的小工具:
    //   _is_callable(v_boxed) -> 0/1       typeof==="function" 等价判定
    //   _dp_check_accessor(v_boxed) -> 0/1 undefined 或可调用 → 1(get/set 合法性)
    //   _dp_require_object(d_boxed)        描述符非(非空)对象 → 抛 TypeError(不返回)
    generateObjectDefinePropertyHelpers() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };

        // _is_callable(v) -> 0/1。装箱函数 tag 0x7FFF;或裸堆指针落 [heap_base,heap_ptr)
        // 且 type@0 ∈ {3(classinfo/TYPE_CLOSURE), 0xc105(CLOSURE_MAGIC), 0xa51c(ASYNC)}。
        vm.label("_is_callable");
        vm.prologue(0, []);
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7fff); vm.jeq("_isc_yes");
        vm.cmpImm(VReg.V1, 0); vm.jne("_isc_no");
        vm.cmpImm(VReg.A0, 0); vm.jeq("_isc_no");
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1); vm.jb("_isc_no");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1); vm.jae("_isc_no");
        vm.load(VReg.V1, VReg.A0, 0);
        vm.mov(VReg.V0, VReg.V1);           // 副本用于低字节 type 检查
        vm.andImm(VReg.V0, VReg.V0, 0xff);   // type 低字节(高字节可含标志位)
        vm.cmpImm(VReg.V0, 3); vm.jeq("_isc_yes");
        vm.cmpImm(VReg.V1, 0xc105); vm.jeq("_isc_yes"); // CLOSURE_MAGIC(全值)
        vm.cmpImm(VReg.V1, 0xa51c); vm.jeq("_isc_yes"); // GEN_MAGIC(全值)
        vm.label("_isc_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);
        vm.label("_isc_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([], 0);

        // _dp_check_accessor(v) -> 0/1。undefined 合法(缺省 get/set);否则须可调用。
        vm.label("_dp_check_accessor");
        vm.prologue(0, []);
        vm.movImm64(VReg.V0, 0x7ffb000000000000n); // undefined
        vm.cmp(VReg.A0, VReg.V0); vm.jeq("_dpca_yes");
        vm.call("_is_callable"); // A0=v 未改;RET=0/1 直接作返回
        vm.epilogue([], 0);
        vm.label("_dpca_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([], 0);

        // _dp_require_object(d)。对象/数组/函数/真实裸堆对象放行；raw Symbol、
        // BigInt 与 denormal Number 也使用 high16==0，须显式排除并做堆界检查。
        vm.label("_dp_require_object");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7ffd); vm.jeq("_dpo_ok");
        vm.cmpImm(VReg.V1, 0x7ffe); vm.jeq("_dpo_ok");
        vm.cmpImm(VReg.V1, 0x7fff); vm.jeq("_dpo_ok");
        vm.cmpImm(VReg.V1, 0); vm.jne("_dpo_throw");
        vm.cmpImm(VReg.S0, 0); vm.jeq("_dpo_throw");
        vm.mov(VReg.A0, VReg.S0); vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0); vm.jne("_dpo_throw");
        vm.mov(VReg.A0, VReg.S0); vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0); vm.jne("_dpo_throw");
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1); vm.jb("_dpo_throw");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1); vm.jae("_dpo_throw");
        vm.jmp("_dpo_ok");
        vm.label("_dpo_throw");
        vm.lea(VReg.A0, vm.asm.addString("Property description must be an object"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error"); // 不返回
        vm.label("_dpo_ok");
        vm.epilogue([VReg.S0], 0);
    }

    // [#dp-mask] _object_define_property(obj_boxed, key, value, get, set, packed=(mask<<8)|attr)
    //   完整实现 ValidateAndApplyPropertyDescriptor(仅对 mask 标记出现的字段生效)+ 落值 + 落 attr。
    //   返回原对象(boxed);非法时 _throw_type_error(不返回)。
    //
    //   帧布局(prologue 96,S0=obj_raw / S1=key 跨调用保活;其余全落 SP 以免疫 _alloc
    //   只保 S0-S3 的约定违例):
    //     SP+0 boxed obj   SP+8 mask     SP+16 idx      SP+24 oldval
    //     SP+32 oldattr(-1=键不存在哨兵) SP+40 oldIsAccessor SP+48 oldGet SP+56 oldSet
    //     SP+64 attr       SP+72 value   SP+80 get      SP+88 set
    generateObjectDefineProperty() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        const throwMsg = (msg) => {
            vm.lea(VReg.A0, vm.asm.addString(msg)); boxStr(VReg.A0); vm.call("_throw_type_error");
        };

        vm.label("_object_define_property");
        vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.store(VReg.SP, 0, VReg.A0);             // boxed obj
        vm.store(VReg.SP, 72, VReg.A2);            // value
        vm.store(VReg.SP, 80, VReg.A3);            // get
        vm.store(VReg.SP, 88, VReg.A4);            // set
        vm.andImm(VReg.V0, VReg.A5, 0xff);
        vm.store(VReg.SP, 64, VReg.V0);            // attr
        vm.shrImm(VReg.V0, VReg.A5, 8);
        vm.store(VReg.SP, 8, VReg.V0);             // mask
        vm.mov(VReg.S1, VReg.A1);                  // key(保活)

        // 接收者守卫:对象/数组/函数/裸堆指针放行;原语抛 TypeError(防脱壳解引用崩)。
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7ffd); vm.jeq("_dp_recv_ok");
        vm.cmpImm(VReg.V1, 0x7ffe); vm.jeq("_dp_recv_ok");
        vm.cmpImm(VReg.V1, 0x7fff); vm.jeq("_dp_recv_ok");
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_recv_ok");
        throwMsg("Cannot define property, target is not an object");
        vm.label("_dp_recv_ok");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1);  // S0 = raw obj

        // ============ [dp-mix] data/accessor 冲突检测(全路径共享)============
        // ES 6.1.7.1 ToPropertyDescriptor:不可同时设 data(value/writable) 与
        // accessor(get/set)。此前仅 _dp_obj_ok 路径检测,_dp_legacy/_dp_array
        // 路径盲写可能导致 accessor block 与 value 并存(语义混乱)。
        vm.load(VReg.V0, VReg.SP, 8);                                  // mask
        vm.andImm(VReg.V1, VReg.V0, DP_HAS_VALUE | DP_HAS_WRITABLE);   // data 位
        vm.andImm(VReg.V2, VReg.V0, DP_HAS_GET | DP_HAS_SET);          // accessor 位
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_mix_ok");
        vm.cmpImm(VReg.V2, 0); vm.jeq("_dp_mix_ok");
        throwMsg("Invalid property descriptor: cannot both specify accessors and a value or writable attribute");
        vm.label("_dp_mix_ok");

        // 类型字节守卫:仅普通对象(2)/classinfo(3)走强制路;数组(1)走 _dp_array。
        // TypedArray 使用内联整数索引布局且没有 props_ptr，具名属性必须进入
        // 闭包侧表（例如 SpeciesConstructor 依赖的自有 constructor 覆盖）。
        // 其余非属性容器仍走 legacy，保持既有行为。
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 2); vm.jeq("_dp_obj_ok");
        vm.cmpImm(VReg.V1, 3); vm.jeq("_dp_obj_ok");
        vm.cmpImm(VReg.V1, 1); vm.jeq("_dp_array");
        vm.cmpImm(VReg.V1, TYPE_TA_LO); vm.jlt("_dp_legacy_check");
        vm.cmpImm(VReg.V1, TYPE_TA_HI); vm.jle("_dp_ta");
        vm.label("_dp_legacy_check");
        vm.jmp("_dp_legacy");

        // ============ ToPropertyDescriptor 验证(get/set 可调用性)============
        vm.label("_dp_obj_ok");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.andImm(VReg.V0, VReg.V0, DP_HAS_GET);
        vm.cmpImm(VReg.V0, 0); vm.jeq("_dp_noget");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.call("_dp_check_accessor");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_dp_badget");
        vm.jmp("_dp_noget");
        vm.label("_dp_badget"); throwMsg("Getter must be a function");
        vm.label("_dp_noget");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.andImm(VReg.V0, VReg.V0, DP_HAS_SET);
        vm.cmpImm(VReg.V0, 0); vm.jeq("_dp_noset");
        vm.load(VReg.A0, VReg.SP, 88);
        vm.call("_dp_check_accessor");
        vm.cmpImm(VReg.RET, 0); vm.jeq("_dp_badset");
        vm.jmp("_dp_noset");
        vm.label("_dp_badset"); throwMsg("Setter must be a function");
        vm.label("_dp_noset");

        // ============ 查找既有属性 ============
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0);            // idx = 0
        vm.label("_dp_loop");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.load(VReg.V3, VReg.S0, 8);              // count(跨调用重载)
        vm.cmp(VReg.V0, VReg.V3); vm.jge("_dp_absent");
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V1, VReg.V0, 4);
        vm.add(VReg.V5, VReg.V2, VReg.V1);         // entry
        vm.load(VReg.A0, VReg.V5, 0);              // 既有 key
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0); vm.jne("_dp_found");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.jmp("_dp_loop");

        // ---- 命中:取 oldval / oldattr / oldIsAccessor / oldGet / oldSet ----
        vm.label("_dp_found");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V1, VReg.V0, 4);
        vm.add(VReg.V5, VReg.V2, VReg.V1);
        vm.load(VReg.V0, VReg.V5, 8);
        vm.store(VReg.SP, 24, VReg.V0);            // oldval
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.call("_object_get_attr");
        vm.store(VReg.SP, 32, VReg.RET);           // oldattr
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 40, VReg.V1);            // oldIsAccessor = 0
        vm.store(VReg.SP, 48, VReg.V1);            // oldGet = 0
        vm.store(VReg.SP, 56, VReg.V1);            // oldSet = 0
        // oldval 是 TYPE_GETTER 标记块?
        vm.load(VReg.V0, VReg.SP, 24);
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0); vm.jne("_dp_old_data");
        vm.cmpImm(VReg.V0, 0); vm.jeq("_dp_old_data");
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1); vm.jlt("_dp_old_data");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1); vm.jge("_dp_old_data");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER); vm.jne("_dp_old_data");
        vm.movImm(VReg.V1, 1); vm.store(VReg.SP, 40, VReg.V1);
        vm.load(VReg.V1, VReg.V0, 8);  vm.store(VReg.SP, 48, VReg.V1);  // oldGet
        vm.load(VReg.V1, VReg.V0, 16); vm.store(VReg.SP, 56, VReg.V1);  // oldSet
        vm.label("_dp_old_data");
        vm.jmp("_dp_present");

        // ---- 键不存在:non-extensible 抛;否则直接落(无当前描述符)----
        vm.label("_dp_absent");
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, EXT_NONEXT);
        vm.cmpImm(VReg.V0, 0); vm.jeq("_dp_absent_ok");
        vm.jmp("_dp_validation_fail");
        vm.label("_dp_absent_ok");
        vm.movImm64(VReg.V0, 0x7ffb000000000000n);
        vm.store(VReg.SP, 24, VReg.V0);            // oldval = undefined
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 40, VReg.V0);            // oldIsAccessor = 0
        vm.store(VReg.SP, 48, VReg.V0);
        vm.store(VReg.SP, 56, VReg.V0);
        vm.movImm64(VReg.V0, 0xFFFFFFFFFFFFFFFFn);
        vm.store(VReg.SP, 32, VReg.V0);            // oldattr = -1(不存在哨兵)
        vm.jmp("_dp_apply");

        // ============ 强制(键已存在)============
        vm.label("_dp_present");
        vm.load(VReg.V0, VReg.SP, 32);             // oldattr
        vm.andImm(VReg.V1, VReg.V0, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V1, 0); vm.jne("_dp_apply"); // 当前 configurable → 放行
        vm.load(VReg.V2, VReg.SP, 8);              // mask
        // (1) HAS_CONFIGURABLE 且置 configurable:true → 抛
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_CONFIGURABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_chk2");
        vm.load(VReg.V0, VReg.SP, 64);             // attr
        vm.andImm(VReg.V1, VReg.V0, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_chk2");
        vm.jmp("_dp_validation_fail");
        // (2) HAS_ENUMERABLE 且 enumerable 与当前不同 → 抛
        vm.label("_dp_chk2");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_ENUMERABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_chk3");
        vm.load(VReg.V0, VReg.SP, 64);
        vm.andImm(VReg.V1, VReg.V0, ATTR_ENUMERABLE);   // 新 en
        vm.load(VReg.V3, VReg.SP, 32);
        vm.andImm(VReg.V3, VReg.V3, ATTR_ENUMERABLE);   // 旧 en
        vm.cmp(VReg.V1, VReg.V3); vm.jne("_dp_throw_redef");
        // (3) data <-> accessor 切换(空描述符两者皆非 → 不抛)
        vm.label("_dp_chk3");
        vm.load(VReg.V5, VReg.SP, 40);             // oldIsAccessor
        vm.andImm(VReg.V3, VReg.V2, DP_HAS_VALUE | DP_HAS_WRITABLE); // descData 位
        vm.andImm(VReg.V4, VReg.V2, DP_HAS_GET | DP_HAS_SET);        // descAcc 位
        vm.cmpImm(VReg.V5, 0); vm.jeq("_dp_chk3_data");
        vm.cmpImm(VReg.V3, 0); vm.jne("_dp_throw_redef"); // 旧 accessor + 新 data → 抛
        vm.jmp("_dp_chk4");
        vm.label("_dp_chk3_data");
        vm.cmpImm(VReg.V4, 0); vm.jne("_dp_throw_redef"); // 旧 data + 新 accessor → 抛
        // (4) 当前 accessor:get/set 同一性;当前 data:不可写时拒改 writable/value
        vm.label("_dp_chk4");
        vm.load(VReg.V5, VReg.SP, 40);
        vm.cmpImm(VReg.V5, 0); vm.jeq("_dp_data_chk");
        // 当前 accessor
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_GET);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_acc_set");
        vm.load(VReg.V3, VReg.SP, 80);
        vm.emitMaskLoad(VReg.V0); vm.andMaskReg(VReg.V3, VReg.V3, VReg.V0); // 新 get 裸指针
        vm.load(VReg.V4, VReg.SP, 48);                                       // oldGet
        vm.cmp(VReg.V3, VReg.V4); vm.jne("_dp_throw_redef");
        vm.label("_dp_acc_set");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_SET);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_apply");
        vm.load(VReg.V3, VReg.SP, 88);
        vm.emitMaskLoad(VReg.V0); vm.andMaskReg(VReg.V3, VReg.V3, VReg.V0);
        vm.load(VReg.V4, VReg.SP, 56);                                       // oldSet
        vm.cmp(VReg.V3, VReg.V4); vm.jne("_dp_throw_redef");
        vm.jmp("_dp_apply");
        // 当前 data
        vm.label("_dp_data_chk");
        vm.load(VReg.V0, VReg.SP, 32);
        vm.andImm(VReg.V0, VReg.V0, ATTR_WRITABLE);    // 当前 writable
        vm.cmpImm(VReg.V0, 0); vm.jne("_dp_apply");    // 可写 → 允许改值/收 writable
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_WRITABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_data_val");
        vm.load(VReg.V0, VReg.SP, 64);
        vm.andImm(VReg.V1, VReg.V0, ATTR_WRITABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_data_val");
        vm.jmp("_dp_throw_redef");                     // 不可写 → 拒置 writable:true
        vm.label("_dp_data_val");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_apply");
        // SameValue(新值, oldval)。双方皆字符串 → 按**内容**(_getStrContent+_strcmp,
        // 免比较箱子指针:"ab" 与 "a"+"b" 内容等而箱子异);否则按**完整 64 位位模式**
        // (数字/布尔/对象同一引用——NaN 已规范化故 NaN==NaN;0 与 -0 位异故不等)。
        // 不可复用 _object_key_eq:其快速路以 JS_PAYLOAD_MASK 取低 48 位,小数双精度
        // (1.0/2.0/0/-0…)的高 16 位(指数/符号)被剥成同值 → 假相等,漏抛 e3/e6/0≠-0。
        vm.load(VReg.S2, VReg.SP, 72);                 // S2 = 新值(boxed,跨调用保活)
        vm.load(VReg.S3, VReg.SP, 24);                 // S3 = oldval(boxed)
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.cmpImm(VReg.V1, 0x7ffc); vm.jne("_dp_sv_bits");   // 新值非串 → 位模式
        vm.shrImm(VReg.V1, VReg.S3, 48);
        vm.cmpImm(VReg.V1, 0x7ffc); vm.jne("_dp_sv_bits");   // 旧值非串 → 位模式
        // 双方字符串:逐字节内容比较
        vm.mov(VReg.A0, VReg.S2); vm.call("_getStrContent"); vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S3); vm.call("_getStrContent"); vm.mov(VReg.S5, VReg.RET);
        vm.mov(VReg.A0, VReg.S4); vm.mov(VReg.A1, VReg.S5); vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0); vm.jne("_dp_throw_redef");   // 内容异 → 抛
        vm.jmp("_dp_apply");
        // 位模式比较(完整 64 位:tag/指数/符号/指针全含)
        vm.label("_dp_sv_bits");
        vm.cmp(VReg.S2, VReg.S3); vm.jne("_dp_throw_redef");
        vm.jmp("_dp_apply");

        vm.label("_dp_throw_redef");
        vm.jmp("_dp_validation_fail");

        // ============ 落值 + 落 attr ============
        vm.label("_dp_apply");
        vm.load(VReg.V2, VReg.SP, 8);              // mask
        // storeValue:新 accessor → 建标记块;否则 data;accessor→data 转换时缺 value → undefined
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_GET | DP_HAS_SET);
        vm.cmpImm(VReg.V1, 0); vm.jne("_dp_apply_acc");
        // data 描述符(或 generic)
        vm.load(VReg.V5, VReg.SP, 40);             // oldIsAccessor
        vm.cmpImm(VReg.V5, 0); vm.jeq("_dp_apply_data_same");
        // 旧为 accessor:仅当 Desc 含 value/writable 才转 data(空 {} 保留 accessor)
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE | DP_HAS_WRITABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_apply_keep");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_apply_conv_undef");
        vm.load(VReg.V5, VReg.SP, 72);
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.SP, 16, VReg.V0); // convertToData=1
        vm.jmp("_dp_apply_store");
        vm.label("_dp_apply_conv_undef");
        vm.movImm64(VReg.V5, 0x7ffb000000000000n);
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.jmp("_dp_apply_store");
        vm.label("_dp_apply_data_same");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0); // convertToData=0
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_apply_keep");
        vm.load(VReg.V5, VReg.SP, 72);             // storeValue = value
        vm.jmp("_dp_apply_store");
        vm.label("_dp_apply_keep");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.load(VReg.V5, VReg.SP, 24);             // storeValue = oldval(保留)
        vm.jmp("_dp_apply_store");
        vm.label("_dp_apply_acc");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 16, VReg.V0); // convertToData=0
        // 标记块:get = HAS_GET? 新 : oldGet;set = HAS_SET? 新 : oldSet
        vm.movImm(VReg.A0, 24); vm.call("_alloc"); // _alloc 毁 V/S4/S5;故全从 SP 取
        vm.mov(VReg.V5, VReg.RET);                 // V5 = 标记块
        vm.movImm(VReg.V1, TYPE_GETTER); vm.store(VReg.V5, 0, VReg.V1);
        vm.load(VReg.V2, VReg.SP, 8);              // mask(重载,_alloc 已毁)
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_GET);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_acc_oldget");
        vm.load(VReg.V3, VReg.SP, 80);
        vm.emitMaskLoad(VReg.V0); vm.andMaskReg(VReg.V3, VReg.V3, VReg.V0);
        vm.store(VReg.V5, 8, VReg.V3);
        vm.jmp("_dp_acc_getdone");
        vm.label("_dp_acc_oldget");
        vm.load(VReg.V3, VReg.SP, 48); vm.store(VReg.V5, 8, VReg.V3);
        vm.label("_dp_acc_getdone");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_SET);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_acc_oldset");
        vm.load(VReg.V3, VReg.SP, 88);
        vm.emitMaskLoad(VReg.V0); vm.andMaskReg(VReg.V3, VReg.V3, VReg.V0);
        vm.store(VReg.V5, 16, VReg.V3);
        vm.jmp("_dp_acc_setdone");
        vm.label("_dp_acc_oldset");
        vm.load(VReg.V3, VReg.SP, 56); vm.store(VReg.V5, 16, VReg.V3);
        vm.label("_dp_acc_setdone");
        // storeValue = V5(标记块裸指针)
        vm.label("_dp_apply_store");
        vm.load(VReg.A0, VReg.SP, 0);              // boxed obj
        vm.mov(VReg.A1, VReg.S1);                  // key
        vm.mov(VReg.A2, VReg.V5);                  // storeValue
        vm.call("_object_define");                 // 落值(新键追加/既有覆写;冻结对象无变更则短路无害)
        // finalAttr:不存在 → attr;存在 → oldattr 仅覆写 mask 标记位;
        // accessor→data 转换时 writable 先清为缺省 false(再按 mask 覆写)
        vm.load(VReg.V0, VReg.SP, 32);             // oldattr
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.V0, VReg.V1); vm.jeq("_dp_attr_new");
        vm.load(VReg.V4, VReg.SP, 16);             // convertToData?
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_dp_attr_merge");
        vm.andImm(VReg.V0, VReg.V0, 0xFE);         // 清 writable
        vm.label("_dp_attr_merge");
        vm.load(VReg.V2, VReg.SP, 8);              // mask
        vm.load(VReg.V3, VReg.SP, 64);             // attr
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_WRITABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_at_en");
        vm.andImm(VReg.V0, VReg.V0, 0xFE);
        vm.andImm(VReg.V1, VReg.V3, ATTR_WRITABLE);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.label("_dp_at_en");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_ENUMERABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_at_cf");
        vm.andImm(VReg.V0, VReg.V0, 0xFD);
        vm.andImm(VReg.V1, VReg.V3, ATTR_ENUMERABLE);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.label("_dp_at_cf");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_CONFIGURABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_attr_store");
        vm.andImm(VReg.V0, VReg.V0, 0xFB);
        vm.andImm(VReg.V1, VReg.V3, ATTR_CONFIGURABLE);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.jmp("_dp_attr_store");
        vm.label("_dp_attr_new");
        vm.load(VReg.V0, VReg.SP, 64);             // finalAttr = attr(缺省位全 false)
        vm.label("_dp_attr_store");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.V0);
        vm.call("_object_set_prop_attr");
        vm.load(VReg.RET, VReg.SP, 0);             // 返回原对象
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        // ============ array:数组 DefineOwnProperty ============
        // S0=裸数组头(type@0,length@8,capacity@16,data_ptr@24),无 props_ptr@32。
        // 不可复用 _dp_legacy(_object_define 读 offset 8 当 count、offset 32 当
        // props_ptr → 数组头只有 32 字节 → 越界)。
        //
        // 策略(W7):索引键 → 侧表做 ValidateAndApply(attrs/强制) + 数组槽同步值;
        // 具名键 → 仅侧表。空档保持 hole 哨兵 0(不填 undefined);+0 → 装箱 int0。
        // arguments 亦 TYPE_ARRAY,同路径。
        vm.label("_dp_array");
        // 键归一(复用 _js_prop_key,同 _ogopd_arr)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        // "length" 特殊:拒 accessor;数据 value → 写 length(简化 ToUint32)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.V0, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_dp_array_length");
        // 判规范数值索引
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index");         // RET = idx / -1
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_dp_array_side");                 // 非索引键 → 具名侧表
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_dp_array_side");
        vm.store(VReg.SP, 16, VReg.RET);           // idx(稠密与稀疏共用)
        // ---- 新索引越界守卫(15.4.5.1 step 4.b/4.c)----
        // idx >= length:抬 length 需 length[[Writable]] 且 [[Extensible]]。
        // 数组 byte1 bit0 兼任 ARR_LEN_NONWRITABLE 与 EXT_NONEXT(既有同位布局)。
        vm.load(VReg.V2, VReg.SP, 16);             // idx
        vm.load(VReg.V3, VReg.S0, 8);              // length
        vm.cmp(VReg.V2, VReg.V3);
        vm.jlt("_dp_array_idx_guard_ok");
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_LEN_NONWRITABLE); // ≡ EXT_NONEXT on arrays
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_dp_array_idx_reject");
        vm.label("_dp_array_idx_guard_ok");
        vm.movImm(VReg.V0, 0x10000000);            // 2^28 soft cap
        vm.load(VReg.V1, VReg.SP, 16);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jge("_dp_array_sparse");               // 大索引:侧表+抬 length

        // ---- 若数组槽已有数据属性但侧表无此键:先以 DEFAULT attrs 播种,供后续强制 ----
        vm.load(VReg.V2, VReg.SP, 16);             // idx
        vm.load(VReg.V3, VReg.S0, 8);              // length
        vm.cmp(VReg.V2, VReg.V3);
        vm.jge("_dp_array_idx_apply");            // 越界 → 无既存数组数据
        vm.load(VReg.V1, VReg.S0, 24);             // data_ptr
        vm.shl(VReg.V0, VReg.V2, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V0, 0);              // slot
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dp_array_idx_apply");            // hole → 无既存数据
        vm.store(VReg.SP, 24, VReg.V0);            // 暂存 old slot 值于 oldval 槽
        vm.load(VReg.A0, VReg.SP, 0);               // boxed arr
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_dp_array_idx_seed");             // 无侧表 → 需播种
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_dp_array_idx_apply");            // 侧表已有 → 不播种
        vm.label("_dp_array_idx_seed");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_closure_props_ensure");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.load(VReg.A2, VReg.SP, 24);             // value = slot
        vm.movImm64(VReg.A3, 0x7ffb000000000000n); // get = undefined
        vm.mov(VReg.A4, VReg.A3);                  // set = undefined
        // mask = VALUE|WRITABLE|ENUM|CONFIG, attr = ATTR_DEFAULT
        vm.movImm(VReg.V0, (DP_HAS_VALUE | DP_HAS_WRITABLE | DP_HAS_ENUMERABLE | DP_HAS_CONFIGURABLE) << 8);
        vm.orImm(VReg.A5, VReg.V0, ATTR_DEFAULT);
        vm.call("_object_define_property");

        // ---- 用户描述符落到侧表(完整强制)----
        vm.label("_dp_array_idx_apply");
        // live *box inject when Desc has no [[Value]] (arguments mapped).
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dp_array_idx_apply_user");
        vm.load(VReg.V2, VReg.SP, 8); // mask
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_dp_array_idx_apply_user");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_GET | DP_HAS_SET);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_dp_array_idx_apply_user");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.call("_args_param_map_get_box");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_dp_array_idx_apply_user");
        vm.load(VReg.V0, VReg.RET, 0); // *box
        vm.store(VReg.SP, 72, VReg.V0);
        vm.load(VReg.V2, VReg.SP, 8);
        vm.orImm(VReg.V2, VReg.V2, DP_HAS_VALUE);
        vm.store(VReg.SP, 8, VReg.V2);
        vm.label("_dp_array_idx_apply_user");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_closure_props_ensure");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        // x64 V2≡A2: pack A5 from stack *before* loading value/get/set,
        // else load V2,mask clobbers the just-loaded define value
        // (arguments defineProperty "foo" became a subnormal / tiny float).
        vm.load(VReg.V1, VReg.SP, 8);              // mask (V1≡A3; A3 not live)
        vm.shlImm(VReg.V1, VReg.V1, 8);
        vm.load(VReg.V5, VReg.SP, 64);             // attr
        vm.or(VReg.A5, VReg.V1, VReg.V5);
        vm.load(VReg.A2, VReg.SP, 72);             // value
        vm.load(VReg.A3, VReg.SP, 80);             // get
        vm.load(VReg.A4, VReg.SP, 88);             // set
        vm.call("_object_define_property");

        // ---- 同步数组槽 + length(空档保持 hole=0; +0→int0)----
        vm.load(VReg.V2, VReg.SP, 16);             // idx
        vm.load(VReg.V0, VReg.S0, 16);             // capacity
        vm.cmp(VReg.V2, VReg.V0);
        vm.jlt("_dp_array_idx_cap_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.V2, 1);
        vm.call("_array_ensure_cap");
        vm.label("_dp_array_idx_cap_ok");
        vm.load(VReg.V3, VReg.S0, 8);              // old length
        vm.cmp(VReg.V2, VReg.V3);
        vm.jlt("_dp_array_idx_len_ok");
        // 空档 [old_len, idx) 显式写 hole 哨兵 0(ensure_cap 不保证清零)
        vm.load(VReg.V1, VReg.S0, 24);
        vm.movImm(VReg.V4, 0);                     // hole
        vm.jmp("_dp_array_idx_gap_test");
        vm.label("_dp_array_idx_gap_loop");
        vm.shl(VReg.V0, VReg.V3, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.store(VReg.V0, 0, VReg.V4);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.label("_dp_array_idx_gap_test");
        vm.cmp(VReg.V3, VReg.V2);
        vm.jlt("_dp_array_idx_gap_loop");
        vm.addImm(VReg.V0, VReg.V2, 1);
        vm.store(VReg.S0, 8, VReg.V0);             // length = idx+1
        vm.label("_dp_array_idx_len_ok");
        // 读侧表最终值:accessor → 槽写 hole;数据 → 写值(+0 规范)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_closure_props_find");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");                   // 不触发 getter(标记块原样返回)
        vm.mov(VReg.V5, VReg.RET);                 // store candidate
        // TYPE_GETTER 标记块?
        vm.shrImm(VReg.V1, VReg.V5, 48);
        vm.cmpImm(VReg.V1, 0); vm.jne("_dp_array_idx_data");
        vm.cmpImm(VReg.V5, 0); vm.jeq("_dp_array_idx_data");
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V5, VReg.V1); vm.jlt("_dp_array_idx_data");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V5, VReg.V1); vm.jge("_dp_array_idx_data");
        vm.load(VReg.V1, VReg.V5, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER); vm.jne("_dp_array_idx_data");
        vm.movImm(VReg.V5, 0);                     // accessor → hole(读走侧表/gOPD)
        vm.jmp("_dp_array_idx_write");
        vm.label("_dp_array_idx_data");
        // +0.0(位全 0)与 hole 同位 → 装箱 int0
        vm.cmpImm(VReg.V5, 0);
        vm.jne("_dp_array_idx_write");
        vm.movImm64(VReg.V5, 0x7ff8000000000000n);
        vm.label("_dp_array_idx_write");
        // x64 V5=R10 is add/mul internal scratch; _gc_remember + add
        // destroyed the store candidate (defineProperty value "foo" → tiny float).
        vm.store(VReg.SP, 24, VReg.V5);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_gc_remember");
        vm.load(VReg.V2, VReg.SP, 16);             // idx
        vm.load(VReg.V1, VReg.S0, 24);
        vm.shl(VReg.V0, VReg.V2, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.V2, VReg.SP, 24);             // candidate (not V5: add scratch)
        vm.store(VReg.V0, 0, VReg.V2);
        // arguments [[ParameterMap]]: data desc → Set(map); accessor → unmap.
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dp_array_idx_no_pmap");
        vm.load(VReg.V2, VReg.SP, 24);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_dp_array_idx_unmap"); // accessor hole → Delete(map, P)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.mov(VReg.A2, VReg.V2);
        vm.call("_args_param_map_after_define");
        // 9.4.4.3 step 6.b.ii: Desc.[[Writable]]===false → Delete(map, P)
        vm.load(VReg.V2, VReg.SP, 8); // mask
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_WRITABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_idx_no_pmap");
        vm.load(VReg.V0, VReg.SP, 64); // attr
        vm.andImm(VReg.V0, VReg.V0, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_dp_array_idx_no_pmap");
        vm.jmp("_dp_array_idx_unmap");
        vm.label("_dp_array_idx_unmap");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.call("_args_param_map_unmap");
        vm.label("_dp_array_idx_no_pmap");
        vm.jmp("_dp_array_done");

        // ---- length:拒 accessor; ToUint32 + writable 位(ARR_LEN_NONWRITABLE) ----
        vm.label("_dp_array_length");
        // arguments.length is ordinary (writable+configurable), not Array [[Length]].
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_dp_array_side");
        // ArraySetLength performs ToUint32 and ToNumber before validating the
        // current length descriptor.  valueOf/@@toPrimitive may mutate the
        // array, and an invalid value must win with RangeError over descriptor
        // errors, so the two observable coercions happen first.
        vm.load(VReg.V2, VReg.SP, 8);              // descriptor field mask
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_len_desc_validate");
        vm.load(VReg.A0, VReg.SP, 72);
        vm.call("_to_uint32");                   // coercion #1
        vm.mov(VReg.S2, VReg.RET);                // newLen
        vm.load(VReg.A0, VReg.SP, 72);
        vm.call("_number_coerce");               // coercion #2
        vm.store(VReg.SP, 48, VReg.RET);          // numberLen bits
        vm.movImm64(VReg.V1, 0x7ff0000000000000n);
        vm.mov(VReg.V0, VReg.RET);
        vm.shlImm(VReg.V0, VReg.V0, 1);
        vm.shrImm(VReg.V0, VReg.V0, 1);           // clear sign bit
        vm.cmp(VReg.V0, VReg.V1);
        vm.jae("_dp_array_len_range");            // NaN / infinities
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.V3, 0);
        vm.load(VReg.V0, VReg.SP, 48);
        vm.cmp(VReg.V3, VReg.V0);
        vm.jeq("_dp_array_len_desc_validate");
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_dp_array_len_range");
        // Only +0/-0 may compare as zero; reject denormals flushed by FP mode.
        vm.shlImm(VReg.V1, VReg.V0, 1);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_dp_array_len_range");
        vm.label("_dp_array_len_desc_validate");
        // length [[Configurable]]/[[Enumerable]] 恒 false:试图改 true → TypeError
        // (15.2.3.7-6-a-116:defineProperties length:{configurable:true})
        vm.load(VReg.V2, VReg.SP, 8);              // mask
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_CONFIGURABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_len_en_chk");
        vm.load(VReg.V0, VReg.SP, 64);
        vm.andImm(VReg.V0, VReg.V0, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_dp_array_idx_reject");           // configurable:true 拒
        vm.label("_dp_array_len_en_chk");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_ENUMERABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_len_acc_chk");
        vm.load(VReg.V0, VReg.SP, 64);
        vm.andImm(VReg.V0, VReg.V0, ATTR_ENUMERABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_dp_array_idx_reject");           // enumerable:true 拒
        vm.label("_dp_array_len_acc_chk");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_GET | DP_HAS_SET);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_len_data");
        vm.jmp("_dp_validation_fail");
        vm.label("_dp_array_len_data");
        // Value coercion/range validation was done before descriptor checks;
        // continue with OrdinaryDefineOwnProperty using the saved newLen.
        vm.label("_dp_array_len_odop");
        // current [[Writable]] 在两次 coerce 之后重读(valueOf 可能已改 writable)。
        vm.loadByte(VReg.V0, VReg.S0, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_LEN_NONWRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dp_array_len_apply");
        // 不可写:Desc.writable===true 或 value 改变 → VAPD false
        vm.load(VReg.V2, VReg.SP, 8);
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_WRITABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_len_nw_val");
        vm.load(VReg.V0, VReg.SP, 64);
        vm.andImm(VReg.V0, VReg.V0, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_dp_array_len_vapd_fail");
        vm.label("_dp_array_len_nw_val");
        vm.load(VReg.V2, VReg.SP, 8);
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_done");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jeq("_dp_array_done");
        vm.label("_dp_array_len_vapd_fail");
        vm.jmp("_dp_validation_fail");
        vm.label("_dp_array_len_apply");
        vm.load(VReg.V2, VReg.SP, 8);
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_WRITABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_len_apply_val");
        vm.load(VReg.V0, VReg.SP, 64);
        vm.andImm(VReg.V0, VReg.V0, ATTR_WRITABLE);
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dp_array_len_wr_off");
        vm.andImm(VReg.V1, VReg.V1, (~ARR_LEN_NONWRITABLE) & 0xff);
        vm.jmp("_dp_array_len_wr_store");
        vm.label("_dp_array_len_wr_off");
        vm.orImm(VReg.V1, VReg.V1, ARR_LEN_NONWRITABLE);
        vm.label("_dp_array_len_wr_store");
        vm.storeByte(VReg.S0, 1, VReg.V1);
        vm.label("_dp_array_len_apply_val");
        vm.load(VReg.V2, VReg.SP, 8);
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_dp_array_done");
        vm.label("_dp_array_len_do");
        // Remove sparse side-table indices first; the returned length may be
        // raised to a non-configurable blocking index + 1 per ArraySetLength.
        vm.store(VReg.SP, 16, VReg.S2);              // requested length
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_array_trim_sparse_side");
        vm.mov(VReg.S2, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 16);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jne("_dp_array_len_sparse_stuck");
        vm.load(VReg.S3, VReg.S0, 8);
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_dp_array_len_set");
        vm.mov(VReg.S4, VReg.S3);
        vm.label("_dp_array_len_shrink");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jle("_dp_array_len_set");
        vm.subImm(VReg.S4, VReg.S4, 1);
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_dp_array_len_dense_del");
        vm.mov(VReg.S5, VReg.RET);
        vm.mov(VReg.A1, VReg.S4);
        vm.scvtf(0, VReg.A1);
        vm.fmovToInt(VReg.A0, 0);
        vm.call("_js_prop_key");
        vm.store(VReg.SP, 24, VReg.RET);
        vm.mov(VReg.A0, VReg.S5);
        vm.load(VReg.A1, VReg.SP, 24);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_dp_array_len_dense_del");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.V5, VReg.S5, VReg.V0);
        vm.load(VReg.V2, VReg.V5, 8);
        vm.movImm(VReg.V3, 0);
        vm.store(VReg.SP, 56, VReg.V5);
        vm.label("_dp_array_len_sfind");
        vm.cmp(VReg.V3, VReg.V2);
        vm.jge("_dp_array_len_dense_del");
        vm.load(VReg.V1, VReg.SP, 56);
        vm.load(VReg.V0, VReg.V1, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V4, VReg.V3, 4);
        vm.add(VReg.V0, VReg.V0, VReg.V4);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.load(VReg.A1, VReg.SP, 24);
        vm.store(VReg.SP, 32, VReg.V3);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_dp_array_len_shit");
        vm.load(VReg.V3, VReg.SP, 32);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.load(VReg.V2, VReg.SP, 56);
        vm.load(VReg.V2, VReg.V2, 8);
        vm.jmp("_dp_array_len_sfind");
        vm.label("_dp_array_len_shit");
        vm.load(VReg.A0, VReg.SP, 56);
        vm.load(VReg.A1, VReg.SP, 32);
        vm.call("_object_get_attr");
        vm.andImm(VReg.V0, VReg.RET, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dp_array_len_stuck");
        vm.mov(VReg.A0, VReg.S5);
        vm.load(VReg.A1, VReg.SP, 24);
        vm.call("_object_delete");
        vm.label("_dp_array_len_dense_del");
        vm.load(VReg.V0, VReg.S0, 16);
        vm.cmp(VReg.S4, VReg.V0);
        vm.jge("_dp_array_len_shrink");
        vm.load(VReg.V1, VReg.S0, 24);
        vm.shl(VReg.V0, VReg.S4, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.jmp("_dp_array_len_shrink");
        vm.label("_dp_array_len_stuck");
        vm.addImm(VReg.V0, VReg.S4, 1);
        vm.store(VReg.S0, 8, VReg.V0);
        vm.jmp("_dp_validation_fail");
        vm.label("_dp_array_len_sparse_stuck");
        vm.store(VReg.S0, 8, VReg.S2);
        vm.jmp("_dp_validation_fail");
        vm.label("_dp_array_len_set");
        vm.store(VReg.S0, 8, VReg.S2);
        vm.jmp("_dp_array_done");
        vm.label("_dp_array_len_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid array length"));
        boxStr(VReg.A0);
        vm.call("_throw_range_error");

        // 大索引稀疏:侧表 + length=idx+1
        vm.label("_dp_array_sparse");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_closure_props_ensure");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        // x64 V2≡A2: pack A5 from stack *before* loading value/get/set,
        // else load V2,mask clobbers the just-loaded define value
        // (arguments defineProperty "foo" became a subnormal / tiny float).
        vm.load(VReg.V1, VReg.SP, 8);              // mask (V1≡A3; A3 not live)
        vm.shlImm(VReg.V1, VReg.V1, 8);
        vm.load(VReg.V5, VReg.SP, 64);             // attr
        vm.or(VReg.A5, VReg.V1, VReg.V5);
        vm.load(VReg.A2, VReg.SP, 72);             // value
        vm.load(VReg.A3, VReg.SP, 80);             // get
        vm.load(VReg.A4, VReg.SP, 88);             // set
        vm.call("_object_define_property");
        vm.load(VReg.V2, VReg.SP, 16);
        vm.load(VReg.V0, VReg.S0, 8);
        vm.addImm(VReg.V1, VReg.V2, 1);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jle("_dp_array_done");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.jmp("_dp_array_done");

        // 具名属性/symbol:走闭包侧表(原路径)
        vm.label("_dp_array_side");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_closure_props_ensure");          // RET = props(boxed 0x7FFD)
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        // x64 V2≡A2: pack A5 from stack *before* loading value/get/set,
        // else load V2,mask clobbers the just-loaded define value
        // (arguments defineProperty "foo" became a subnormal / tiny float).
        vm.load(VReg.V1, VReg.SP, 8);              // mask (V1≡A3; A3 not live)
        vm.shlImm(VReg.V1, VReg.V1, 8);
        vm.load(VReg.V5, VReg.SP, 64);             // attr
        vm.or(VReg.A5, VReg.V1, VReg.V5);
        vm.load(VReg.A2, VReg.SP, 72);             // value
        vm.load(VReg.A3, VReg.SP, 80);             // get
        vm.load(VReg.A4, VReg.SP, 88);             // set
        vm.call("_object_define_property");
        vm.label("_dp_array_done");
        vm.load(VReg.RET, VReg.SP, 0);                // 返原始数组 boxed
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        vm.label("_dp_array_idx_reject");
        vm.jmp("_dp_validation_fail");

        // Ordinary validation failures are false for Reflect.defineProperty
        // and abrupt TypeError completions for Object.defineProperty.  The
        // packed descriptor mode bit makes this decision local to the call,
        // so nested defineProperty from valueOf cannot leak a global mode.
        vm.label("_dp_validation_fail");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.andImm(VReg.V0, VReg.V0, DP_REFLECT_MODE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dp_validation_throw");
        vm.movImm64(VReg.RET, 0x7ff9000000000000n); // boxed false
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);
        vm.label("_dp_validation_throw");
        throwMsg("Cannot redefine property");

        // ============ TypedArray: integer-indexed + named side-table ==========
        // S1 is the already ToPropertyKey-normalized key.  Ordinary named
        // properties are defined on a side-table object so descriptor
        // validation and attribute merging use the canonical object path.
        vm.label("_dp_ta");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index");
        vm.mov(VReg.S2, VReg.RET);             // idx or -1 (non-index)
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jeq("_dp_ta_named");

        // Integer-indexed element descriptors may not become accessors,
        // non-enumerable, non-writable, or configurable properties.
        vm.load(VReg.V0, VReg.SP, 8);          // descriptor field mask
        vm.andImm(VReg.V1, VReg.V0, DP_HAS_GET | DP_HAS_SET);
        vm.cmpImm(VReg.V1, 0); vm.jne("_dp_ta_idx_reject");
        vm.andImm(VReg.V1, VReg.V0, DP_HAS_CONFIGURABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_ta_idx_enum");
        vm.load(VReg.V1, VReg.SP, 64);
        vm.andImm(VReg.V1, VReg.V1, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V1, ATTR_CONFIGURABLE); vm.jne("_dp_ta_idx_reject");
        vm.label("_dp_ta_idx_enum");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.andImm(VReg.V1, VReg.V0, DP_HAS_ENUMERABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_ta_idx_write");
        vm.load(VReg.V1, VReg.SP, 64);
        vm.andImm(VReg.V1, VReg.V1, ATTR_ENUMERABLE);
        vm.cmpImm(VReg.V1, ATTR_ENUMERABLE); vm.jne("_dp_ta_idx_reject");
        vm.label("_dp_ta_idx_write");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.andImm(VReg.V1, VReg.V0, DP_HAS_WRITABLE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_ta_idx_validate");
        vm.load(VReg.V1, VReg.SP, 64);
        vm.andImm(VReg.V1, VReg.V1, ATTR_WRITABLE);
        vm.cmpImm(VReg.V1, ATTR_WRITABLE); vm.jne("_dp_ta_idx_reject");
        vm.label("_dp_ta_idx_validate");
        // ValidateTypedArray rejects detached/OOB receivers.  An out-of-range
        // index is likewise a failed integer-indexed definition.
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_tam_throw_if_detached");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_typed_array_length");
        vm.cmp(VReg.S2, VReg.RET); vm.jge("_dp_ta_idx_reject");
        vm.load(VReg.V0, VReg.SP, 8);
        vm.andImm(VReg.V1, VReg.V0, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_ta_done");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S2);
        vm.load(VReg.A2, VReg.SP, 72);
        vm.call("_typed_array_set");
        vm.label("_dp_ta_done");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);
        vm.label("_dp_ta_idx_reject");
        vm.jmp("_dp_validation_fail");

        vm.label("_dp_ta_named");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_closure_props_ensure");
        vm.mov(VReg.S2, VReg.RET);             // boxed ordinary props object
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        // x64 V1 aliases A3 (RCX): build the packed descriptor before loading
        // the getter into A3, otherwise the mask overwrites the getter and
        // `_dp_check_accessor` reports "Getter must be a function".
        vm.load(VReg.V1, VReg.SP, 8);
        vm.shlImm(VReg.V1, VReg.V1, 8);
        vm.load(VReg.V5, VReg.SP, 64);
        vm.or(VReg.A5, VReg.V1, VReg.V5);
        vm.load(VReg.A2, VReg.SP, 72);
        vm.load(VReg.A3, VReg.SP, 80);
        vm.load(VReg.A4, VReg.SP, 88);
        vm.call("_object_define_property");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        // ============ legacy:非普通对象(Map/…)旧行为;函数值走侧表 ============
        vm.label("_dp_legacy");
        // 函数(0x7FFF):无对象头,_object_define 落在闭包 magic 上无效。与数组具名键同形
        // —— ensure 侧表后递归 _object_define_property(props,…)。name/length 若尚未在侧表,
        // 先以元数据值 + 规范 attr(w:false,e:false,c:true) 播种,再应用用户描述符(使
        // defineProperty(fn,"length",{enumerable:true}) 合并而非把 value 打成 undefined)。
        vm.load(VReg.A0, VReg.SP, 0);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_dp_fn_side");
        // Fixed-layout exotics cannot be passed to _object_define as ordinary
        // object headers.  Their named properties use the same side table as
        // arrays/functions; recurse there to retain full descriptor validation.
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jeq("_dp_array_side");
        vm.cmpImm(VReg.V1, TYPE_PROMISE);
        vm.jeq("_dp_array_side");
        vm.cmpImm(VReg.V1, TYPE_MAP);
        vm.jeq("_dp_array_side");
        vm.cmpImm(VReg.V1, TYPE_SET);
        vm.jeq("_dp_array_side");
        vm.load(VReg.V2, VReg.SP, 8);              // mask
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_GET | DP_HAS_SET);
        vm.cmpImm(VReg.V1, 0); vm.jne("_dp_leg_acc");
        vm.andImm(VReg.V1, VReg.V2, DP_HAS_VALUE);
        vm.cmpImm(VReg.V1, 0); vm.jeq("_dp_leg_undef");
        vm.load(VReg.V5, VReg.SP, 72);
        vm.jmp("_dp_leg_store");
        vm.label("_dp_leg_undef");
        vm.movImm64(VReg.V5, 0x7ffb000000000000n);
        vm.jmp("_dp_leg_store");
        vm.label("_dp_leg_acc");
        vm.movImm(VReg.A0, 24); vm.call("_alloc");
        vm.mov(VReg.V5, VReg.RET);
        vm.movImm(VReg.V1, TYPE_GETTER); vm.store(VReg.V5, 0, VReg.V1);
        vm.load(VReg.V3, VReg.SP, 80);
        vm.emitMaskLoad(VReg.V0); vm.andMaskReg(VReg.V3, VReg.V3, VReg.V0);
        vm.store(VReg.V5, 8, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 88);
        vm.emitMaskLoad(VReg.V0); vm.andMaskReg(VReg.V3, VReg.V3, VReg.V0);
        vm.store(VReg.V5, 16, VReg.V3);
        vm.label("_dp_leg_store");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.V5);
        vm.call("_object_define");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.load(VReg.A2, VReg.SP, 64);             // attr
        vm.call("_object_set_prop_attr");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        vm.label("_dp_fn_side");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_closure_props_ensure");
        vm.store(VReg.SP, 16, VReg.RET);           // props boxed @ SP+16
        // name/length 未在侧表 → 播种规范形状(可配置数据属性)
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_dp_fn_apply");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_dp_fn_seed_ck");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_dp_fn_apply");
        vm.label("_dp_fn_seed_ck");
        vm.load(VReg.A0, VReg.SP, 16);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_dp_fn_apply");                   // 侧表已有 → 直接合并用户描述符
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_closure_prop_get");             // 元数据值(无侧表条目时)
        vm.mov(VReg.S3, VReg.RET);
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jeq("_dp_fn_apply");                   // 匿名/未登记 → 不播种,按 absent 定义
        vm.load(VReg.A0, VReg.SP, 16);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S3);
        vm.movImm64(VReg.A3, 0x7ffb000000000000n);
        vm.mov(VReg.A4, VReg.A3);
        vm.movImm(VReg.V0, (DP_HAS_VALUE | DP_HAS_WRITABLE | DP_HAS_ENUMERABLE | DP_HAS_CONFIGURABLE) << 8);
        vm.orImm(VReg.A5, VReg.V0, ATTR_CONFIGURABLE); // w:0 e:0 c:1
        vm.call("_object_define_property");
        vm.label("_dp_fn_apply");
        vm.load(VReg.A0, VReg.SP, 16);
        vm.mov(VReg.A1, VReg.S1);
        // x64 V2≡A2: pack A5 from stack *before* loading value/get/set,
        // else load V2,mask clobbers the just-loaded define value
        // (arguments defineProperty "foo" became a subnormal / tiny float).
        vm.load(VReg.V1, VReg.SP, 8);              // mask (V1≡A3; A3 not live)
        vm.shlImm(VReg.V1, VReg.V1, 8);
        vm.load(VReg.V5, VReg.SP, 64);             // attr
        vm.or(VReg.A5, VReg.V1, VReg.V5);
        vm.load(VReg.A2, VReg.SP, 72);             // value
        vm.load(VReg.A3, VReg.SP, 80);             // get
        vm.load(VReg.A4, VReg.SP, 88);             // set
        vm.call("_object_define_property");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);
    }

    // [#dp-mask] _object_define_property_dyn(obj_boxed, key, desc_boxed):动态描述符回退。
    //   逐字段经 _object_get 读一次(走原型链,数组/对象皆宜,访问器 getter 只求值一次),
    //   presence 取“值 !== undefined”(sanctioned 近似 [[HasProperty]]),运行时算 mask/attr,
    //   打包后尾调 _object_define_property。描述符非对象先抛。
    generateObjectDefinePropertyDyn() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_reflect_define_property_dyn");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm(VReg.V0, DP_REFLECT_MODE);
        vm.store(VReg.SP, 40, VReg.V0);
        vm.jmp("_dpd_entry");
        vm.label("_object_define_property_dyn");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 40, VReg.V0);
        vm.label("_dpd_entry");
        vm.mov(VReg.S0, VReg.A0);                  // obj boxed
        vm.mov(VReg.S1, VReg.A1);                  // key
        vm.mov(VReg.S2, VReg.A2);                  // desc
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_dp_require_object");             // 非对象 → 抛
        // SP+0 value  SP+8 get  SP+16 set  SP+24 mask  SP+32 attr
        vm.movImm64(VReg.V0, 0x7ffb000000000000n);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.store(VReg.SP, 8, VReg.V0);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 24, VReg.V0);
        vm.store(VReg.SP, 32, VReg.V0);

        let uid = 0;
        const field = (name, presBit, isBool, slot, attrShift) => {
            const s = uid++;
            const skipL = `_dpd_skip_${s}`;
            const walkL = `_dpd_walk_${s}`;
            // ToPropertyDescriptor:HasProperty + Get,须沿 [[Prototype]]。
            // 函数/Arguments 作描述符时自有表无 "value"/"writable",字段在
            // Function.prototype / Object.prototype 上(15.2.3.6-3-139-1 等)。
            // _object_get 对 0x7FFF/arguments 只查侧表,不走原型 → 在此显式爬链。
            vm.mov(VReg.S3, VReg.S2);              // current = desc
            vm.movImm(VReg.S4, 0);                 // hop 上限,防环
            vm.label(walkL);
            vm.addImm(VReg.S4, VReg.S4, 1);
            vm.cmpImm(VReg.S4, 64);
            vm.jge(skipL);
            // presence 用 _object_has(own)。数组/arguments miss 读出是 0 不是
            // undefined,不能靠 Get!==undefined 判缺(否则 writable:继承 true 被
            // 当成自有 0 → false,15.2.3.6-3-175-1)。
            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, vm.asm.addString(name)); boxStr(VReg.A1);
            vm.call("_object_has");
            vm.cmpImm(VReg.RET, 0);
            vm.jne("_dpd_hit_" + s);
            vm.mov(VReg.A0, VReg.S3);
            vm.call("_object_getPrototypeOf");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq(skipL);
            vm.shrImm(VReg.V1, VReg.RET, 48);
            vm.cmpImm(VReg.V1, 0x7FFA); vm.jeq(skipL); // null
            vm.cmpImm(VReg.V1, 0x7FFB); vm.jeq(skipL); // undefined
            vm.mov(VReg.S3, VReg.RET);
            vm.jmp(walkL);
            vm.label("_dpd_hit_" + s);
            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, vm.asm.addString(name)); boxStr(VReg.A1);
            vm.call("_object_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_maybe_getter");
            vm.load(VReg.V2, VReg.SP, 24);         // (x64 V2==A2 无活值;V0≡RET 会盖掉下方待存的解析值)
            vm.orImm(VReg.V2, VReg.V2, presBit);
            vm.store(VReg.SP, 24, VReg.V2);        // mask |= presBit
            if (isBool) {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");            // RET 0/1
                vm.shlImm(VReg.V1, VReg.RET, attrShift);
                vm.load(VReg.V2, VReg.SP, 32);
                vm.or(VReg.V2, VReg.V2, VReg.V1);
                vm.store(VReg.SP, 32, VReg.V2);    // attr |= bit
            } else {
                vm.store(VReg.SP, slot, VReg.RET); // value/get/set
            }
            vm.label(skipL);
        };
        field("value", DP_HAS_VALUE, false, 0, 0);
        field("writable", DP_HAS_WRITABLE, true, 0, 0);
        field("enumerable", DP_HAS_ENUMERABLE, true, 0, 1);
        field("configurable", DP_HAS_CONFIGURABLE, true, 0, 2);
        field("get", DP_HAS_GET, false, 8, 0);
        field("set", DP_HAS_SET, false, 16, 0);

        // x64 V1≡A3 (RCX): pack A5 from mask/attr BEFORE loading get.
        // Old order left A3=attr (tiny int) → "Getter must be a function"
        // on Object.defineProperty(o, k, descVar) (4-213).
        vm.load(VReg.V0, VReg.SP, 24);             // mask
        vm.load(VReg.V1, VReg.SP, 40);             // Object=0 / Reflect=mode bit
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.shlImm(VReg.V0, VReg.V0, 8);
        vm.load(VReg.V1, VReg.SP, 32);             // attr
        vm.or(VReg.A5, VReg.V0, VReg.V1);          // packed
        vm.mov(VReg.A0, VReg.S0);                  // obj
        vm.mov(VReg.A1, VReg.S1);                  // key
        vm.load(VReg.A2, VReg.SP, 0);              // value
        vm.load(VReg.A3, VReg.SP, 8);              // get
        vm.load(VReg.A4, VReg.SP, 16);             // set
        vm.call("_object_define_property");        // RET = obj(或抛)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // [W7b] 数组索引侧表元素读写(供 _subscript_get/_set):
    //   _array_side_elem_has(A0=arr, A1=idx) -> 0/1
    //   _array_side_elem_get(A0=arr, A1=idx) -> 值(先 has;this=arr 触发 getter)
    //   _array_side_elem_set(A0=arr, A1=idx, A2=value) -> 0=继续稠密写 / 1=已处理
    generateArraySideElementHelpers() {
        const vm = this.vm;
        const idxToKey = () => {
            vm.scvtf(0, VReg.A1);
            vm.fmovToInt(VReg.A0, 0);
            vm.call("_js_prop_key");
        };
        let _asesBoxUid = 0;
        const boxArrThis = () => {
            // S0=arr → A5=boxed 0x7FFE (若已装箱则原样)
            const u = _asesBoxUid++;
            const keep = `_ases_box_keep_${u}`;
            const done = `_ases_box_done_${u}`;
            vm.shrImm(VReg.V2, VReg.S0, 48);
            vm.cmpImm(VReg.V2, 0x7FFE);
            vm.jeq(keep);
            vm.movImm64(VReg.V1, 0x7ffe000000000000n);
            vm.or(VReg.A5, VReg.S0, VReg.V1);
            vm.jmp(done);
            vm.label(keep);
            vm.mov(VReg.A5, VReg.S0);
            vm.label(done);
        };

        vm.label("_array_side_elem_has");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, ARR_HAS_SIDETABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_aseh_no");
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_aseh_no");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        idxToKey();
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_object_has");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_aseh_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        vm.label("_array_side_elem_get");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, ARR_HAS_SIDETABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_aseg_undef");
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_aseg_undef");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        idxToKey();
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        boxArrThis();
        vm.mov(VReg.A1, VReg.A5);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_aseg_undef");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        vm.label("_array_side_elem_set");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.movImm(VReg.V0, 0x10000000);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_ases_sparse");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.andImm(VReg.V1, VReg.V1, ARR_HAS_SIDETABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ases_cont");
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ases_cont");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        idxToKey();
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ases_cont");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_get");
        vm.mov(VReg.S5, VReg.RET);
        // accessor?
        vm.shrImm(VReg.V1, VReg.S5, 48);
        vm.cmpImm(VReg.V1, 0); vm.jne("_ases_data");
        vm.cmpImm(VReg.S5, 0); vm.jeq("_ases_data");
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S5, VReg.V1); vm.jlt("_ases_data");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S5, VReg.V1); vm.jge("_ases_data");
        vm.load(VReg.V1, VReg.S5, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER); vm.jne("_ases_data");
        vm.load(VReg.V0, VReg.S5, 16);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ases_reject"); // getter-only → 2 (strict TypeError)
        vm.movImm64(VReg.V1, 0x7ffb000000000000n);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_ases_reject");
        boxArrThis();
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1); vm.jlt("_ases_acc_call");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1); vm.jge("_ases_acc_call");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105); vm.jeq("_ases_acc_cl");
        vm.cmpImm(VReg.V1, 0xa51c); vm.jne("_ases_acc_call");
        vm.label("_ases_acc_cl");
        vm.mov(VReg.S3, VReg.V0); // 保活闭包(S0=arr 不可毁)
        vm.load(VReg.V0, VReg.S3, 8);
        vm.mov(VReg.S0, VReg.S3); // callIndirect 约定:S0=闭包
        vm.label("_ases_acc_call");
        vm.setCallArgcImm(1, VReg.V1, VReg.V2);
        vm.callIndirect(VReg.V0);
        vm.jmp("_ases_done");
        vm.label("_ases_data");
        // writable?
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.V5, VReg.S3, VReg.V0);
        vm.load(VReg.V2, VReg.V5, 8);
        vm.movImm(VReg.V3, 0);
        vm.store(VReg.SP, 0, VReg.V5);
        vm.label("_ases_find");
        vm.cmp(VReg.V3, VReg.V2);
        vm.jge("_ases_cont");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.load(VReg.V0, VReg.V1, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V4, VReg.V3, 4);
        vm.add(VReg.V0, VReg.V0, VReg.V4);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S4);
        vm.store(VReg.SP, 8, VReg.V3);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ases_found");
        vm.load(VReg.V3, VReg.SP, 8);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.load(VReg.V2, VReg.SP, 0);
        vm.load(VReg.V2, VReg.V2, 8);
        vm.jmp("_ases_find");
        vm.label("_ases_found");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_object_get_attr");
        vm.andImm(VReg.V0, VReg.RET, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ases_reject"); // nonwritable data → 2
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_define");
        vm.label("_ases_cont");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_ases_reject");
        // 2 = reject write (getter-only / nonwritable). Caller throws in strict.
        vm.movImm(VReg.RET, 2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_ases_done");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        // 稀疏大索引:侧表写入 + length 抬升
        vm.label("_ases_sparse");
        vm.call("_closure_props_ensure");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        idxToKey();
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ases_sp_put");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_object_get");
        vm.mov(VReg.S5, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S5, 48);
        vm.cmpImm(VReg.V1, 0); vm.jne("_ases_sp_data");
        vm.cmpImm(VReg.S5, 0); vm.jeq("_ases_sp_data");
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S5, VReg.V1); vm.jlt("_ases_sp_data");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S5, VReg.V1); vm.jge("_ases_sp_data");
        vm.load(VReg.V1, VReg.S5, 0);
        vm.cmpImm(VReg.V1, TYPE_GETTER); vm.jne("_ases_sp_data");
        vm.load(VReg.V0, VReg.S5, 16);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ases_sp_len");
        boxArrThis();
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.V1, "_heap_base"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1); vm.jlt("_ases_sp_acc");
        vm.lea(VReg.V1, "_heap_ptr"); vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.V0, VReg.V1); vm.jge("_ases_sp_acc");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0xc105); vm.jeq("_ases_sp_cl");
        vm.cmpImm(VReg.V1, 0xa51c); vm.jne("_ases_sp_acc");
        vm.label("_ases_sp_cl");
        vm.mov(VReg.S3, VReg.V0);
        vm.load(VReg.V0, VReg.S3, 8);
        vm.mov(VReg.S0, VReg.S3);
        vm.label("_ases_sp_acc");
        vm.setCallArgcImm(1, VReg.V1, VReg.V2);
        vm.callIndirect(VReg.V0);
        vm.jmp("_ases_sp_len");
        vm.label("_ases_sp_data");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.V5, VReg.S3, VReg.V0);
        vm.load(VReg.V2, VReg.V5, 8);
        vm.movImm(VReg.V3, 0);
        vm.store(VReg.SP, 0, VReg.V5);
        vm.label("_ases_spf");
        vm.cmp(VReg.V3, VReg.V2);
        vm.jge("_ases_sp_put");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.load(VReg.V0, VReg.V1, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V4, VReg.V3, 4);
        vm.add(VReg.V0, VReg.V0, VReg.V4);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S4);
        vm.store(VReg.SP, 8, VReg.V3);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ases_spf_hit");
        vm.load(VReg.V3, VReg.SP, 8);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.load(VReg.V2, VReg.SP, 0);
        vm.load(VReg.V2, VReg.V2, 8);
        vm.jmp("_ases_spf");
        vm.label("_ases_spf_hit");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_object_get_attr");
        vm.andImm(VReg.V0, VReg.RET, ATTR_WRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ases_done");
        vm.label("_ases_sp_put");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_define");
        vm.label("_ases_sp_len");
        // 2^32-1 and above are ordinary named properties, not ArrayIndex
        // keys.  Store them in the side table but never raise [[ArrayLength]].
        vm.movImm64(VReg.V0, 4294967295n);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_ases_done");
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jne("_ases_sp_raw");
        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.V2, VReg.S0, VReg.V0);
        vm.jmp("_ases_sp_len2");
        vm.label("_ases_sp_raw");
        vm.mov(VReg.V2, VReg.S0);
        vm.label("_ases_sp_len2");
        vm.load(VReg.V0, VReg.V2, 8);
        vm.addImm(VReg.V1, VReg.S1, 1);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jle("_ases_done");
        vm.store(VReg.V2, 8, VReg.V1);
        vm.jmp("_ases_done");
    }

    generateArrayTrimSparseSide() {
        const vm = this.vm;
        // Remove sparse side-table array-index properties when ArraySetLength
        // shrinks below the dense capacity. Dense storage is handled by the
        // caller's descending loop; this covers indices at or above capacity
        // (including 2^32-2) without allocating a giant backing array.
        // RET is the requested length on success or blockingIndex+1 when a
        // non-configurable property stops deletion.
        vm.label("_array_trim_sparse_side");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        // threshold = max(requested length, dense capacity)
        vm.load(VReg.V0, VReg.S0, 16);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jlt("_ats_threshold_len");
        vm.mov(VReg.V0, VReg.S1);
        vm.label("_ats_threshold_len");
        vm.store(VReg.SP, 8, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.mov(VReg.S2, VReg.RET);
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jeq("_ats_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S2, VReg.S2, VReg.V1); // raw props object

        vm.label("_ats_scan_restart");
        vm.movImm(VReg.S3, 0);                  // scan position
        vm.movImm64(VReg.S4, 0xFFFFFFFFFFFFFFFFn); // best index = -1
        vm.movImm(VReg.S5, 0);                  // best position
        vm.label("_ats_scan");
        vm.load(VReg.V2, VReg.S2, 8);           // current property count
        vm.cmp(VReg.S3, VReg.V2);
        vm.jge("_ats_scan_done");
        vm.load(VReg.V1, VReg.S2, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S3, 4);
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.A0, VReg.V1, 0);           // candidate key
        vm.store(VReg.SP, 16, VReg.A0);
        vm.call("_canonical_array_index");
        vm.mov(VReg.V0, VReg.RET);
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_ats_next");                  // non-index key
        vm.load(VReg.V1, VReg.SP, 8);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_ats_next");                  // below dense/specified bound
        vm.cmp(VReg.V0, VReg.S4);
        vm.jle("_ats_next");
        vm.mov(VReg.S4, VReg.V0);
        vm.mov(VReg.S5, VReg.S3);
        vm.load(VReg.V1, VReg.SP, 16);
        vm.store(VReg.SP, 0, VReg.V1);         // best key
        vm.label("_ats_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ats_scan");
        vm.label("_ats_scan_done");
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.S4, VReg.V1);
        vm.jeq("_ats_done");
        // A non-configurable side property is the first deletion barrier.
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_object_get_attr");
        vm.andImm(VReg.V0, VReg.RET, ATTR_CONFIGURABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ats_blocked");
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 0);
        vm.call("_object_delete");
        vm.jmp("_ats_scan_restart");
        vm.label("_ats_blocked");
        vm.addImm(VReg.RET, VReg.S4, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
        vm.label("_ats_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
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
    // [[OwnPropertyKeys]] 序——整数索引键升序 → 字符串键插入序 → symbol 插入序。
    // **无缓存位、每次枚举调用前调它**:先 O(n) 扫描判「是否已有序」,
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

        // ===== pass 1:判是否需重排(整数键越序 / 字符串落于 symbol 后 / 整数落于串|符后)=====
        // S2=lastIntVal(-1) S3=sawString(0) S4=idx;[SP+56]=needReorder(0);[SP+48]=sawSymbol(0)
        vm.movImm64(VReg.S2, NEG1);
        vm.movImm(VReg.S3, 0);
        vm.movImm(VReg.S4, 0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 56, VReg.V0);
        vm.store(VReg.SP, 48, VReg.V0); // sawSymbol(check 阶段暂用;重排段改存 oldFlags)
        vm.label("_ono_chk");
        vm.cmp(VReg.S4, VReg.S1);
        vm.jge("_ono_checked");
        vm.load(VReg.V2, VReg.S0, OBJECT_PROPS_PTR_OFFSET);
        vm.shlImm(VReg.V0, VReg.S4, 4);
        vm.add(VReg.V0, VReg.V2, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0); // key
        vm.store(VReg.SP, 0, VReg.A0); // 保 key(跨 _canonical/_is_symbol)
        vm.call("_canonical_array_index"); // RET=idx/-1;S0-S5 保活
        vm.movImm64(VReg.V1, NEG1);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ono_chk_noint"); // 非整数键
        // 整数键:若已见字符串/symbol → 越序;若 idx < lastIntVal → 越序
        vm.cmpImm(VReg.S3, 0);
        vm.jne("_ono_chk_need");
        vm.load(VReg.V0, VReg.SP, 48); // sawSymbol
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ono_chk_need");
        vm.cmp(VReg.RET, VReg.S2);
        vm.jlt("_ono_chk_need");
        vm.mov(VReg.S2, VReg.RET); // lastIntVal = idx
        vm.jmp("_ono_chk_next");
        vm.label("_ono_chk_noint");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ono_chk_sym");
        // 字符串键:若已见 symbol → 越序(ES:字符串先于 symbol)
        vm.load(VReg.V0, VReg.SP, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ono_chk_need");
        vm.movImm(VReg.S3, 1); // sawString
        vm.jmp("_ono_chk_next");
        vm.label("_ono_chk_sym");
        vm.movImm(VReg.V0, 1);
        vm.store(VReg.SP, 48, VReg.V0); // sawSymbol
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
        vm.jeq("_ono_done"); // 已有序 → 零改

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

        // ---- Phase B:字符串键按插入序(排除 symbol)----
        vm.label("_ono_pb");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.label("_ono_pb_scan");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jge("_ono_pc");
        vm.load(VReg.V1, VReg.SP, 40); // oldProps
        vm.shlImm(VReg.V2, VReg.V0, 4);
        vm.add(VReg.V1, VReg.V1, VReg.V2);
        vm.load(VReg.A0, VReg.V1, 0); // key
        vm.store(VReg.SP, 8, VReg.A0); // 暂存 key(bestVal 槽闲置于 pb)
        vm.call("_canonical_array_index");
        vm.movImm64(VReg.V1, NEG1);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_ono_pb_next"); // 整数键已在 Phase A
        vm.load(VReg.A0, VReg.SP, 8);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ono_pb_next"); // symbol → Phase C
        vm.load(VReg.V0, VReg.SP, 0); // scanIdx
        vm.store(VReg.SP, 16, VReg.V0); // bestPropI = scanIdx
        this._emitOnoCopy(vm);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.label("_ono_pb_next");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_ono_pb_scan");

        // ---- Phase C:symbol 键按插入序 ----
        vm.label("_ono_pc");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.label("_ono_pc_scan");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jge("_ono_pb_done");
        vm.load(VReg.V1, VReg.SP, 40);
        vm.shlImm(VReg.V2, VReg.V0, 4);
        vm.add(VReg.V1, VReg.V1, VReg.V2);
        vm.load(VReg.A0, VReg.V1, 0);
        vm.store(VReg.SP, 8, VReg.A0);
        vm.call("_canonical_array_index");
        vm.movImm64(VReg.V1, NEG1);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_ono_pc_next"); // 整数跳过
        vm.load(VReg.A0, VReg.SP, 8);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ono_pc_next"); // 非 symbol 已在 B
        vm.load(VReg.V0, VReg.SP, 0);
        vm.store(VReg.SP, 16, VReg.V0);
        this._emitOnoCopy(vm);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.label("_ono_pc_next");
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.jmp("_ono_pc_scan");
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
        // [ToObject] 目标 null(0x7FFA)/undefined(0x7FFB)→ TypeError(ES 20.1.2.8 step 1,
        // 先于 ToPropertyKey;node: "Cannot convert undefined or null to object")。其余原语
        // (数值 0x7FF8/裸 float 位、布尔 0x7FF9、字符串 0x7FFC、symbol)继续下行:脱壳后 payload
        // 为 0 或 < ptrFloor(数值/布尔)→ undefined,或类型字节不受理(字符串块)→ undefined,
        // 皆不抛(与 node 一致:仅 null/undefined 抛)。
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jeq("_ogopd_nullish");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_ogopd_nullish");
        // [ToPropertyKey] 复用下标读写同一归一器:数值/布尔/null/undefined/对象 → 字符串键,
        // 字符串/symbol 原样。此前 gOPD 直接拿原始装箱值比键,gOPD(o, 1)/gOPD(o, undefined)
        // 恒返 undefined(ES 20.1.2.8 step 2 = ToPropertyKey(P))。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        // [W-22] 函数值(0x7FFF)在脱壳解引用**之前**分流:函数不是对象块,下方按对象头读
        // 类型字节必然不等 TYPE_OBJECT → 恒 undefined(见 _ogopd_fn)。
        // [string prim] 字符串原语(0x7FFC):包装成 String 对象查自有属性(length / 字符索引)。
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_ogopd_string");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_ogopd_fn");
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
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY (allocator.js) — 数组头非对象布局,见 _ogopd_arr
        vm.jeq("_ogopd_arr");
        vm.cmpImm(VReg.V1, TYPE_TA_LO);
        vm.jlt("_ogopd_not_ta");
        vm.cmpImm(VReg.V1, TYPE_TA_HI);
        vm.jle("_ogopd_ta");
        vm.label("_ogopd_not_ta");
        vm.cmpImm(VReg.V1, TYPE_DATE);
        vm.jeq("_ogopd_exotic_side");
        vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION (classinfo) — same layout as TYPE_OBJECT
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
        // classinfo 已物化 per-prop flags(方法/访问器 attr=5,字段默认 7,name/length=4)。
        // 不再按 type=3 强清 enumerable,否则 CreateDataPropertyOrThrow 的静态字段
        // 会被 verifyProperty 报不可枚举。
        this._emitDescSetBool(0, "enumerable", 32, ATTR_ENUMERABLE);
        this._emitDescSetBool(0, "configurable", 32, ATTR_CONFIGURABLE);
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // ===== data: {value,writable,enumerable,configurable} =====
        vm.label("_ogopd_data");
        this._emitDescSetReg(0, "value", VReg.S5);
        this._emitDescSetBool(0, "writable", 32, ATTR_WRITABLE);
        // 信任 flags:静态方法 attr=5(不可枚举),静态字段默认 7(可枚举)。
        this._emitDescSetBool(0, "enumerable", 32, ATTR_ENUMERABLE);
        this._emitDescSetBool(0, "configurable", 32, ATTR_CONFIGURABLE);
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // ===== [string prim] 字符串原语包装:String 对象自有属性 =====
        // S0 = 装箱字符串(0x7FFC), S1 = 归一装箱键。原语无堆块,不脱壳解引用;
        // 直接取内容长度与字符。ES:String 异质对象有两个自有:"length"(数据,
        // writable:false,enumerable:false,configurable:false)和规范数值索引字符
        // (数据,writable:false,enumerable:true,configurable:false,0<=idx<len)。
        vm.label("_ogopd_string");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent"); // RET = 内容指针(裸指针,非装箱)
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_strlen");        // RET = 字符串长度(int)
        vm.mov(VReg.S3, VReg.RET);
        // 仅处理装箱字符串键(0x7FFC);symbol 键在字符串原语上无自有属性
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_ogopd_undef");
        // 匹配 "length"
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogopd_str_length");
        // 试规范数值索引
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index"); // RET = 索引(int) 或 -1
        vm.mov(VReg.S4, VReg.RET);
        vm.cmpImm(VReg.S4, -1);
        vm.jeq("_ogopd_undef");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_ogopd_undef"); // idx >= len → 不存在
        // 取字符:内容[idx] 的 1 字节 → 装箱成 1 字符字符串
        // leftover V0 smash / wrapper boxing RET: _alloc returns in
        // V0≡RET, so storeByte(RET, 0, V0) wrote the alloc-ptr low
        // byte (empty string vs "f"). _alloc only saves S0-S3; spill
        // the char byte to [SP+40] (frame is 48; [SP+0] desc, [SP+32] attr).
        // loadByte offset is immediate-only; VReg.S4 is the string "S4"
        // (emits a garbage disp32, empty char). Add S2+S4 then load [addr+0].
        vm.add(VReg.S5, VReg.S2, VReg.S4);
        vm.loadByte(VReg.V0, VReg.S5, 0);
        vm.store(VReg.SP, 40, VReg.V0);
        vm.movImm(VReg.A0, 2); // 分配 2 字节("X\0")
        vm.call("_alloc");
        vm.load(VReg.V1, VReg.SP, 40);
        vm.storeByte(VReg.RET, 0, VReg.V1);
        vm.movImm(VReg.V1, 0);
        vm.storeByte(VReg.RET, 1, VReg.V1); // 空终止
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");     // RET = 装箱 1-字符
        vm.mov(VReg.S5, VReg.RET);
        // 构建描述符 {value: char, writable:false, enumerable:true, configurable:false}
        vm.call("_object_new");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V0); // desc boxed
        this._emitDescSetReg(0, "value", VReg.S5);
        vm.lea(VReg.V0, "_js_false"); vm.load(VReg.V0, VReg.V0, 0);
        this._emitDescSetReg(0, "writable", VReg.V0);
        vm.lea(VReg.V0, "_js_true"); vm.load(VReg.V0, VReg.V0, 0);
        this._emitDescSetReg(0, "enumerable", VReg.V0);
        vm.lea(VReg.V0, "_js_false"); vm.load(VReg.V0, VReg.V0, 0);
        this._emitDescSetReg(0, "configurable", VReg.V0);
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        // "length" 属性
        vm.label("_ogopd_str_length");
        vm.scvtf(0, VReg.S3);          // FP0 = float(length)
        vm.fmovToInt(VReg.S5, 0);      // S5 = float64 位(兼容整数/浮点读)
        vm.call("_object_new");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V0);
        this._emitDescSetReg(0, "value", VReg.S5);
        // leftover-boolean boxing: _emitDescSetReg → _object_set smashes
        // V0≡RET. One _js_false load reused for writable/enumerable/
        // configurable left IEEE denormals (1.2e-322 / 3e-323) vs false.
        // Reload into callee-saved S5 (value already stored; _object_set
        // preserves S0-S5) so all three attrs stay boxed false.
        vm.lea(VReg.S5, "_js_false"); vm.load(VReg.S5, VReg.S5, 0);
        this._emitDescSetReg(0, "writable", VReg.S5);
        this._emitDescSetReg(0, "enumerable", VReg.S5);
        this._emitDescSetReg(0, "configurable", VReg.S5);
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // ===== TypedArray own-property descriptor =====
        // Integer-indexed elements expose the fixed descriptor shape
        // (writable/enumerable/configurable all true); named properties are
        // ordinary descriptors in the per-TA side table.
        vm.label("_ogopd_ta");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index");
        vm.mov(VReg.S4, VReg.RET);
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.S4, VReg.V1);
        vm.jeq("_ogopd_ta_named");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_typed_array_length");
        vm.cmp(VReg.S4, VReg.RET);
        vm.jge("_ogopd_undef");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_typed_array_get");
        vm.mov(VReg.S5, VReg.RET);
        vm.call("_object_new");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.movImm(VReg.V2, ATTR_DEFAULT);
        vm.store(VReg.SP, 32, VReg.V2);
        vm.jmp("_ogopd_data");
        vm.label("_ogopd_ta_named");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ogopd_undef");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        vm.label("_ogopd_undef");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // [ToObject] null/undefined 目标 → TypeError(不返回)。消息装箱同 _object_gopn_nullish /
        // _object_getPrototypeOf_nullish 的既有形态(数据段字面量掩码 + 0x7FFC 串 tag)。
        vm.label("_ogopd_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回

        // ===== [arr] TYPE_ARRAY 自有属性描述符(S2=裸数组头, S1=已归一装箱键, S0=原装箱值)=====
        // 数组头 32 字节 {type@0, length@8, capacity@16, data_ptr@24},无 props_ptr@32——绝不能
        // 落 _ogopd_obj 按对象头遍历(把 capacity 当 count、[头+32] 当 props_ptr 解引用垃圾)。
        // ES 数组自有属性三分:
        //   "length" → 数据描述符 {value:len, writable:true, enumerable:false, configurable:false}
        //              (attr = ATTR_WRITABLE = 1,node 实测形状);
        //   规范数值索引键(CanonicalNumericIndexString;判据复用 _canonical_array_index,与
        //   _object_set_array :2396 / _subscript_get_strkey :388 读写同裁决)且 idx<length →
        //   元素描述符 {value:elem, writable+enumerable+configurable 全真}(attr = ATTR_DEFAULT = 7);
        //   idx>=length(越界)→ undefined;
        //   其余键(具名 a.foo=9 / symbol / .raw)→ 闭包属性侧表(写侧 _object_set_fnprops →
        //   _closure_prop_set 同一张表;查法与 _ogopd_fn_side :6312 相同:_closure_props_find +
        //   递归描述 props 对象)。
        // arguments 也是 TYPE_ARRAY,本分支同样受理(gOPD(arguments,"0"))。
        // 描述符构建复用 _ogopd_data 尾段(S5=value, [SP+0]=desc, [SP+32]=attr);其 classinfo
        // 判定读 [S2+0] 类型字节,数组=1≠3 恒跳过,无旁路。
        vm.label("_ogopd_arr");
        // 非字符串键(symbol 等)不做内容比较,直落侧表(_object_key_eq 对非串键虽不误判,
        // 但省一次 call 且语义更直白)。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_ogopd_arr_side");
        // "length" 内容比较:复用驻留常量 _str_length_prop + _object_key_eq(动态拼出的
        // "length" 也认),同 _subscript_get_named :411-415。
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.V0, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1); // 装箱字符串键 "length"
        vm.call("_object_key_eq"); // 内容比较;S0-S3 由其 prologue 保活
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ogopd_arr_len");
        // 规范数值索引键?
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index"); // RET = idx(0..2^32-2) / -1(非索引);不写 S2-S5
        vm.mov(VReg.S3, VReg.RET); // 先取走 idx(x64 上 V0≡RET,下方 movImm64 会冲)
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jeq("_ogopd_arr_side"); // 非索引字符串键("foo"/"01"/"1.0"/"-0"…)→ 侧表
        // [W7] 侧表优先:defineProperty 写下的 attrs/accessor 以侧表为准
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ogopd_arr_idx_slot");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_ogopd_arr_side_hit"); // 侧表命中 → 返回该描述符
        vm.label("_ogopd_arr_idx_slot");
        vm.load(VReg.V0, VReg.S2, 8); // length
        vm.cmp(VReg.S3, VReg.V0);
        vm.jge("_ogopd_undef"); // 越界 → undefined
        // Arguments [[ParameterMap]]: gOPD("0") must report the live formal,
        // not the entry-time dense snapshot (a=7 then gOPD still showed 1).
        vm.loadByte(VReg.V0, VReg.S2, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ogopd_arr_dense");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_args_param_map_get_box");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogopd_arr_dense");
        vm.load(VReg.S5, VReg.RET, 0); // *box (0 is number 0, not hole)
        vm.jmp("_ogopd_arr_idx_desc");
        vm.label("_ogopd_arr_dense");
        vm.load(VReg.V1, VReg.S2, 24); // data_ptr
        vm.shl(VReg.V0, VReg.S3, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.S5, VReg.V0, 0); // 元素值
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_ogopd_undef"); // hole → 不存在
        vm.label("_ogopd_arr_idx_desc");
        vm.call("_object_new");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V0); // desc boxed
        // Dense index descriptors derive integrity attributes from the Array
        // exotic header.  freeze makes indices non-writable/non-configurable;
        // seal keeps writable but clears configurable.  No per-index side
        // table is needed for the dense common case.
        vm.loadByte(VReg.V0, VReg.S2, 1);
        vm.andImm(VReg.V1, VReg.V0, EXT_FROZEN);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_ogopd_arr_idx_frozen");
        vm.andImm(VReg.V1, VReg.V0, EXT_ARRAY_SEALED);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_ogopd_arr_idx_sealed");
        vm.movImm(VReg.V2, ATTR_DEFAULT); // 7 = W+E+C
        vm.jmp("_ogopd_arr_idx_attr");
        vm.label("_ogopd_arr_idx_frozen");
        vm.movImm(VReg.V2, ATTR_ENUMERABLE); // E only
        vm.jmp("_ogopd_arr_idx_attr");
        vm.label("_ogopd_arr_idx_sealed");
        vm.movImm(VReg.V2, ATTR_WRITABLE | ATTR_ENUMERABLE); // W+E
        vm.label("_ogopd_arr_idx_attr");
        vm.store(VReg.SP, 32, VReg.V2); // attr
        vm.jmp("_ogopd_data");
        vm.label("_ogopd_arr_side_hit");
        // Arguments [[GetOwnProperty]] (9.4.4.2): OrdinaryGetOwnProperty then
        // if mapped, desc.[[Value]] = Get(map, P). Side-table attrs stay.
        vm.loadByte(VReg.V1, VReg.S2, 1);
        vm.andImm(VReg.V1, VReg.V1, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ogopd_arr_side_ret");
        vm.mov(VReg.S4, VReg.RET); // desc
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_args_param_map_get_box");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogopd_arr_side_restore");
        vm.load(VReg.S5, VReg.RET, 0); // *box
        vm.mov(VReg.A0, VReg.S4);
        vm.lea(VReg.A1, this.vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogopd_arr_side_restore"); // accessor: leave get/set
        vm.mov(VReg.A0, VReg.S4);
        vm.lea(VReg.A1, this.vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_object_set");
        vm.label("_ogopd_arr_side_restore");
        vm.mov(VReg.RET, VReg.S4);
        vm.label("_ogopd_arr_side_ret");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // "length":value = 长度装箱;attr 缺省仅 writable;ARR_LEN_NONWRITABLE → writable:false。
        vm.label("_ogopd_arr_len");
        // arguments.length: side-table override first; else header + {W+C, !E}.
        vm.loadByte(VReg.V0, VReg.S2, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ogopd_arr_len_array");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ogopd_arr_len_args_def");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_ogopd_arr_side_ret");
        vm.label("_ogopd_arr_len_args_def");
        vm.load(VReg.V0, VReg.S2, 8);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0);
        vm.mov(VReg.S5, VReg.RET);
        vm.call("_object_new");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.movImm(VReg.V2, ATTR_WRITABLE | ATTR_CONFIGURABLE); // 5
        vm.store(VReg.SP, 32, VReg.V2);
        vm.jmp("_ogopd_data");
        vm.label("_ogopd_arr_len_array");
        vm.load(VReg.V0, VReg.S2, 8); // length
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0);
        vm.mov(VReg.S5, VReg.RET); // value = JS number
        vm.call("_object_new");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V0); // desc boxed
        vm.loadByte(VReg.V0, VReg.S2, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_LEN_NONWRITABLE);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ogopd_arr_len_ro");
        vm.movImm(VReg.V2, ATTR_WRITABLE); // 1 = 仅 writable
        vm.jmp("_ogopd_arr_len_attr");
        vm.label("_ogopd_arr_len_ro");
        vm.movImm(VReg.V2, 0); // writable:false, enumerable:false, configurable:false
        vm.label("_ogopd_arr_len_attr");
        vm.store(VReg.SP, 32, VReg.V2); // attr
        vm.jmp("_ogopd_data");

        // 具名/symbol 自有属性:闭包属性侧表(与 _object_set 数组具名写 _closure_prop_set 同表,
        // 键是裸数组指针,故传装箱/裸均可——_closure_props_find 内部脱壳)。无侧表/键 miss →
        // undefined;命中 → 递归描述 props 对象(TYPE_OBJECT,不会再落本分支,无环)。
        vm.label("_ogopd_arr_side");
        // arguments @@iterator: install own copy of Array.prototype.values
        // if proto is already filled (verifyProperty evaluates [][Symbol.iterator]
        // before gOPD, so this lazy path sees the real function identity).
        vm.loadByte(VReg.V0, VReg.S2, 1);
        vm.andImm(VReg.V0, VReg.V0, ARR_IS_ARGUMENTS);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ogopd_arr_side_find");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_args_install_iterator");
        vm.label("_ogopd_arr_side_find");
        vm.mov(VReg.A0, VReg.S0); // 原装箱数组(或裸指针)
        vm.call("_closure_props_find"); // RET = props(装箱 0x7FFD)/undefined
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ogopd_undef");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // Date and similar fixed-layout exotics keep user-defined properties
        // in _closure_props_* rather than in their compact instance header.
        vm.label("_ogopd_exotic_side");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ogopd_undef");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
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

        // ===== [W-22] 函数值(0x7FFF)的自有属性描述符(S0=fn 值, S1=已归一键)=====
        // 函数无对象头(闭包 {magic@0, code_ptr@8, 捕获槽...} 或裸代码指针,既无 props_ptr@32
        // 也无 flags_ptr@40),自有具名属性挂在 _closure_props_* 侧表——与 _object_get 的
        // 0x7FFF 分支、_object_keys_fn / _object_gopn_fn 同一张表。此前任何函数值都落到上方
        // 「脱壳 → 类型字节 != TYPE_OBJECT」→ undefined,故 gOPD(fn, 任意键) 恒 undefined;
        // 看着能用的只有 gOPD(<字面量函数>, "name"|"length"),那是编译期拦截(functions.js
        // 的 _fnNameLength 合成),函数一经变量/形参传递即失效——test262 propertyHelper.js
        // 的 verifyProperty(Math.abs, "name", …) 正是这种传递形态。
        // 两类键:
        //   name/length → node 形状 {value, writable:false, enumerable:false, configurable:true};
        //   其余键      → 递归描述侧表 props(普通对象 TYPE_OBJECT,不会再落本分支,无环),
        //                 属性特性位由该对象真实持有(gOPN(fn) 报出的侧表键都能被描述)。
        // [W-27] length 的**值**现由元数据侧表的 arity@24 供给(_func_meta_arity,经
        // _closure_prop_get 的 _cpg_len 回落):用户函数/类方法/已登记内建都能报出真值。
        // 未登记的函数(匿名普通函数、未收录的内建)仍返 undefined——不编造 0,与
        // _closure_prop_get / _object_gopn_fn 注释中的 length 语义一致。
        vm.label("_ogopd_fn");
        // 非字符串键(symbol 等)不进 _strcmp(避免拿 tag 位当地址),直接查侧表
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_ogopd_fn_side");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent"); // 装箱串 → 内容指针
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogopd_fn_name");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogopd_fn_len");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_getStrContent");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.call("_strcmp");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ogopd_fn_side");
        // 惰性创建 F.prototype,使 gOPD 在首次读前也能看到自有属性(test262 13.2-18-1)。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_closure_prop_get");
        vm.mov(VReg.S5, VReg.RET); // prototype 对象
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S5, VReg.V1);
        vm.jeq("_ogopd_undef");
        // 读侧表真实描述符(%TypedArray%.prototype attr=0;用户函数惰性建 attr=1)
        vm.jmp("_ogopd_fn_side");

        // (legacy hardcoded prototype desc removed — always use side table attrs)

        // 普通自有属性:侧表 props 对象上的真实描述符(无侧表/键 miss → undefined)
        vm.label("_ogopd_fn_side");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find"); // RET = props(装箱 0x7FFD)/undefined
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ogopd_undef");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // name/length:取值仍走 _closure_prop_get(侧表优先——一等 Error 构造器把 .name 挂在
        // 侧表;miss 且键是 "name" 时它回落 _func_meta_name 反射元数据名)。键必须换成**数据段
        // 字面量**键再传:_closure_prop_get 的 name 回落用的是键 payload 与 addString("name")
        // 的**地址**比较,用户传来的堆串(即便内容相同)不会命中。
        vm.label("_ogopd_fn_name");
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.jmp("_ogopd_fn_meta_or_side");
        vm.label("_ogopd_fn_len");
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.label("_ogopd_fn_meta_or_side");
        // 侧表已有 name/length(defineProperty 覆盖)→ 用真实描述符(含 enumerable)
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.S2, VReg.A1, VReg.V1); // 字面量键(供 _object_has)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ogopd_fn_meta");
        vm.mov(VReg.S3, VReg.RET); // props
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogopd_fn_meta");
        // 内建方法经 _closure_prop_set 落 name/length 时 attr=DEFAULT(7)；规范形状是
        // w:false/e:false/c:true。仅当 attr 偏离默认(defineProperty 覆盖)才信侧表描述符。
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_closure_prop_attr");
        vm.cmpImm(VReg.RET, ATTR_DEFAULT);
        vm.jeq("_ogopd_fn_meta");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1); // 原键(堆串亦可)
        vm.call("_object_getOwnPropertyDescriptor");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // name/length:取值仍走 _closure_prop_get(侧表优先——一等 Error 构造器把 .name 挂在
        // 侧表;miss 且键是 "name" 时它回落 _func_meta_name 反射元数据名)。键必须换成**数据段
        // 字面量**键再传:_closure_prop_get 的 name 回落用的是键 payload 与 addString("name")
        // 的**地址**比较,用户传来的堆串(即便内容相同)不会命中。
        vm.label("_ogopd_fn_meta");
        vm.mov(VReg.A1, VReg.S2); // 已是字面量装箱键
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_prop_get");
        vm.mov(VReg.S5, VReg.RET); // 命中值
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S5, VReg.V1);
        vm.jeq("_ogopd_undef"); // 匿名/未登记函数的 name、无 arity 的 length → 无此属性
        vm.call("_object_new");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.SP, 0, VReg.V0); // desc boxed
        this._emitDescSetReg(0, "value", VReg.S5);
        // 特性位不来自 attr 字节(侧表是普通对象,位全默认),按 node 对函数 name/length 的
        // 规范形状直写:writable:false / enumerable:false / configurable:true。
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.V0, VReg.V0, 0);
        this._emitDescSetReg(0, "writable", VReg.V0);
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.V0, VReg.V0, 0);
        this._emitDescSetReg(0, "enumerable", VReg.V0);
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.V0, VReg.V0, 0);
        this._emitDescSetReg(0, "configurable", VReg.V0);
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // obj.propertyIsEnumerable(key) -> js_true/js_false。own 属性的 enumerable 位;
    // 非 own(或非对象)→ false。
    // [fix] ToObject 语义:null/undefined this → TypeError
    generateObjectPropertyIsEnumerable() {
        const vm = this.vm;
        vm.label("_object_propertyIsEnumerable");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        // [fix] null/undefined this → TypeError(ToObject)
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA); // null
        vm.jeq("_opie_nullish");
        vm.cmpImm(VReg.V1, 0x7FFB); // undefined
        vm.jne("_opie_notnull");
        vm.label("_opie_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.label("_opie_notnull");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // raw obj
        vm.mov(VReg.S1, VReg.A1); // key boxed
        // ToPropertyKey: pie(obj, 0) ≡ pie(obj, "0")。对象路径此前未归一,
        // classinfo `static 0` 的 verifyProperty 恒败(hasOwn/gOPD 已归一)。
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_opie_key_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_opie_key_ok");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_opie_false");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_opie_false");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY — 数组头非对象布局,专用分支(见 _opie_arr)
        vm.jeq("_opie_arr");
        vm.cmpImm(VReg.V1, TYPE_TA_LO);
        vm.jlt("_opie_not_ta");
        vm.cmpImm(VReg.V1, TYPE_TA_HI);
        vm.jle("_opie_ta");
        vm.label("_opie_not_ta");
        vm.cmpImm(VReg.V1, TYPE_OBJECT);
        vm.jeq("_opie_obj");
        // classinfo(type=3):props/flags 与普通对象同布局。此前恒 false →
        // verifyProperty(C, 静态字段) 的 isEnumerable(for-in ∧ pie) 恒败。
        vm.cmpImm(VReg.V1, 3);
        vm.jne("_opie_false");
        vm.label("_opie_obj");
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

        // TypedArray indexed and named properties are both covered by the
        // canonical own-descriptor implementation; returning its enumerable
        // field keeps side-table attributes and integer-index rules aligned.
        vm.label("_opie_ta");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_getOwnPropertyDescriptor");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_opie_false");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, this.vm.asm.addString("enumerable"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // ===== [L1-A] TYPE_ARRAY:数组自有属性 enumerable 位(S0=裸数组头, S1=键)=====
        // 此前数组恒落 _opie_false → verifyProperty(arr, index) 的 isEnumerable 探针
        // (for-in ∧ hasOwn ∧ propertyIsEnumerable)恒败(built-ins/Object defineProperty
        // 数组索引簇 "descriptor should be enumerable" 根因)。语义对齐 _ogopd_arr 三分:
        //   "length" → false(规范:数组 length 不可枚举);
        //   侧表命中(defineProperty 落过 attr 的索引/具名/symbol 键)→ 递归 props 对象
        //   (TYPE_OBJECT,读真实 per-property attr);
        //   未 define 过的稠密元素(idx∈[0,len)、槽非 hole)→ 默认 attr 全 1 → true。
        // 热路径零影响:仅 propertyIsEnumerable 反射位到达;侧表查询以 ARR_HAS_SIDETABLE
        // 判位 O(1) 短路(同 _array_side_elem_* 形态),普通数组一条 loadByte 即过。
        vm.label("_opie_arr");
        // 键归一(数值键 → 字符串,同 _ogopd_arr;pie(arr, 0) ≡ pie(arr, "0"))
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jeq("_opie_arr_key_ok");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_prop_key");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_opie_arr_key_ok");
        // 非字符串键(symbol)只可能在侧表 → 跳过 length/索引判定
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_opie_arr_side");
        // "length":自有但不可枚举 → false(内容比较,动态拼串也认)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.V0, "_str_length_prop");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.V0, VReg.V1);
        vm.call("_object_key_eq");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_opie_false");
        // 侧表优先(与 _ogopd_arr 同序:defineProperty 的 attr 以侧表为准)
        vm.label("_opie_arr_side");
        vm.loadByte(VReg.V1, VReg.S0, 1);
        vm.andImm(VReg.V1, VReg.V1, ARR_HAS_SIDETABLE);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_opie_arr_dense");
        vm.mov(VReg.A0, VReg.S0); // 裸数组指针(侧表键;_closure_props_find 内部脱壳兼容)
        vm.call("_closure_props_find");
        vm.lea(VReg.V1, "_js_undefined");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_opie_arr_dense");
        vm.mov(VReg.S2, VReg.RET); // props(装箱 0x7FFD)
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_opie_arr_dense"); // 侧表无此键 → 稠密槽默认 attr
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_propertyIsEnumerable"); // 递归:props 是 TYPE_OBJECT,无环
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        // 稠密元素:规范数值索引 ∈ [0,len) 且槽非 hole → 默认可枚举 true;其余 false
        vm.label("_opie_arr_dense");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC);
        vm.jne("_opie_false"); // symbol 且侧表 miss → 非自有
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_canonical_array_index"); // RET = idx(0..2^32-2) / -1(非索引)
        vm.mov(VReg.S3, VReg.RET); // 先取走 idx(x64 上 V0≡RET)
        vm.movImm64(VReg.V1, 0xFFFFFFFFFFFFFFFFn);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jeq("_opie_false"); // 非索引具名键且侧表 miss → 非自有
        vm.load(VReg.V0, VReg.S0, 8); // length
        vm.cmp(VReg.S3, VReg.V0);
        vm.jge("_opie_false");
        vm.load(VReg.V0, VReg.S0, 16); // capacity(稀疏大 length 防 OOB 读)
        vm.cmp(VReg.S3, VReg.V0);
        vm.jge("_opie_false");
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V0, VReg.S3, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_opie_false"); // hole → 非自有
        vm.lea(VReg.RET, "_js_true");
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

    // [ES2024] Object.groupBy(items, cb) -> null-prototype object {key: [元素...]}
    // Always consume through GetIterator.  Besides accepting strings/custom iterables, this
    // preserves the observable next/callback interleaving and honours overridden array
    // iterators.  Abrupt callback/ToPropertyKey completion closes the iterator before rethrow.
    generateObjectGroupBy() {
        const vm = this.vm;
        const MASK48 = 0x0000ffffffffffffn;
        const TAG_ARRAY = 0x7ffe000000000000n;
        vm.label("_object_groupBy");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // items
        vm.mov(VReg.S1, VReg.A1); // cb

        // Object.groupBy steps 1-2: RequireObjectCoercible(items), then IsCallable(cb).
        vm.shrImm(VReg.V3, VReg.S0, 48);
        vm.cmpImm(VReg.V3, 0x7FFA);
        vm.jeq("_ogb_nullish");
        vm.cmpImm(VReg.V3, 0x7FFB);
        vm.jeq("_ogb_nullish");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogb_not_callable");

        // OrdinaryObjectCreate(null).  _object_new_raw deliberately leaves __proto__ at 0.
        vm.call("_object_new_raw");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_object");
        vm.mov(VReg.S2, VReg.RET);

        // iteratorRecord = GetIterator(items).
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_get_method_iterator");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogb_default_iterator");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_spread_call0");
        vm.jmp("_ogb_check_iterator");

        // Dynamic Get cannot see compiler-intrinsic Array/String prototype methods when the
        // corresponding prototype object has not been materialised.  A missing method on a
        // genuine intrinsic receiver therefore falls back to the same iterator objects used by
        // arr.values()/String.prototype[@@iterator].  Explicit/custom callable methods won above.
        vm.label("_ogb_default_iterator");
        // A present own override whose value was undefined must suppress the intrinsic fallback
        // (GetMethod then fails).  Arrays keep computed/symbol properties in their side table.
        vm.lea(VReg.A0, "_symwk_iterator");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ogb_not_iterable");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ogb_not_iterable");
        vm.shrImm(VReg.V3, VReg.S0, 48);
        vm.cmpImm(VReg.V3, 0x7FFE);
        vm.jne("_ogb_default_string");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V3, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V3, VReg.V3, 0);
        vm.cmpImm(VReg.V3, 1); // TYPE_ARRAY
        vm.jne("_ogb_not_iterable");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0); // values
        vm.call("_array_iterator_new");
        vm.jmp("_ogb_check_iterator");
        vm.label("_ogb_default_string");
        vm.cmpImm(VReg.V3, 0x7FFC);
        vm.jne("_ogb_not_iterable");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_str_iterator_new");

        vm.label("_ogb_check_iterator");
        vm.shrImm(VReg.V3, VReg.RET, 48);
        vm.cmpImm(VReg.V3, 0x7FFD);
        vm.jeq("_ogb_iterator_ok");
        vm.cmpImm(VReg.V3, 0x7FFE);
        vm.jeq("_ogb_iterator_ok");
        vm.cmpImm(VReg.V3, 0x7FFF);
        vm.jne("_ogb_bad_iterator");
        vm.label("_ogb_iterator_ok");
        vm.mov(VReg.S3, VReg.RET); // iterator
        vm.movImm(VReg.S4, 0);     // index

        vm.label("_ogb_loop");
        // next = Get(iterator, "next"); Call(next, iterator); IteratorComplete/Value.
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_maybe_getter");
        vm.store(VReg.SP, 24, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ogb_bad_next");
        vm.load(VReg.A0, VReg.SP, 24);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_spread_call0");
        vm.mov(VReg.S5, VReg.RET); // iterator result
        vm.shrImm(VReg.V3, VReg.S5, 48);
        vm.cmpImm(VReg.V3, 0x7FFD);
        vm.jeq("_ogb_result_ok");
        vm.cmpImm(VReg.V3, 0x7FFE);
        vm.jeq("_ogb_result_ok");
        vm.cmpImm(VReg.V3, 0x7FFF);
        vm.jne("_ogb_bad_result");
        vm.label("_ogb_result_ok");
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
        vm.jne("_ogb_done");
        vm.mov(VReg.A0, VReg.S5);
        vm.lea(VReg.A1, vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_maybe_getter");
        vm.store(VReg.SP, 0, VReg.RET); // element

        // Only callback/coercion/group insertion abrupt completions perform IteratorClose.
        vm.lea(VReg.V1, "_exc_ctx_top");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.store(VReg.SP, 32, VReg.V2);
        vm.lea(VReg.V2, "_ogb_catch");
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

        // key = ToPropertyKey(Call(cb, undefined, «element, index»)).
        vm.load(VReg.A1, VReg.SP, 0);
        vm.mov(VReg.A0, VReg.S1); // cb
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.A2, 0); // index number
        vm.call("_groupby_invoke2");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_prop_key");
        vm.store(VReg.SP, 8, VReg.RET); // key

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
        vm.call("_array_push_own");
        // Pop the temporary exception context before requesting the next item.
        vm.load(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_ogb_loop");

        vm.label("_ogb_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);

        vm.label("_ogb_catch");
        vm.load(VReg.V1, VReg.SP, 32);
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_iterator_close_keep");
        vm.call("_throw_unwind");

        vm.label("_ogb_nullish");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, MASK48); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_ogb_not_callable");
        vm.lea(VReg.A0, vm.asm.addString("Object.groupBy callback must be a function"));
        vm.movImm64(VReg.V1, MASK48); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_ogb_not_iterable");
        vm.lea(VReg.A0, vm.asm.addString("object is not iterable"));
        vm.movImm64(VReg.V1, MASK48); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_ogb_bad_iterator");
        vm.lea(VReg.A0, vm.asm.addString("Result of iterator method is not an object"));
        vm.movImm64(VReg.V1, MASK48); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_ogb_bad_next");
        vm.lea(VReg.A0, vm.asm.addString("iterator next is not callable"));
        vm.movImm64(VReg.V1, MASK48); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_ogb_bad_result");
        vm.lea(VReg.A0, vm.asm.addString("iterator result is not an object"));
        vm.movImm64(VReg.V1, MASK48); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
    }

    // [Annex B] Object.prototype.__defineGetter__/__defineSetter__/__lookupGetter__/__lookupSetter__
    // 经 _aref_generic 进入:A0=this, A1=name, A2=getter|setter。
    // define* ≈ DefinePropertyOrThrow({[Get|Set]:fn, enumerable:true, configurable:true});
    // lookup* 沿原型链 gOPD,命中 accessor 返 [[Get]]/[[Set]],命中 data 返 undefined。
    // 复用 _object_define_property / _object_defineProperty_proxy / gOPD / getPrototypeOf。
    generateAnnexBLegacyAccessors() {
        const vm = this.vm;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        const throwTE = (msg) => {
            vm.lea(VReg.A0, vm.asm.addString(msg));
            boxStr(VReg.A0);
            vm.call("_throw_type_error");
        };
        // packed = (mask<<8)|attr; attr = enumerable|configurable (=6)
        // defineGetter mask = GET|ENUM|CONFIG (=28); defineSetter mask = SET|ENUM|CONFIG (=44)
        const PACK_GET = ((DP_HAS_GET | DP_HAS_ENUMERABLE | DP_HAS_CONFIGURABLE) << 8) |
            (ATTR_ENUMERABLE | ATTR_CONFIGURABLE);
        const PACK_SET = ((DP_HAS_SET | DP_HAS_ENUMERABLE | DP_HAS_CONFIGURABLE) << 8) |
            (ATTR_ENUMERABLE | ATTR_CONFIGURABLE);

        // ── shared: ToObject(this) nullish → TypeError ──
        // A0=recv in; preserves A1/A2 via S1/S2. Leaves S0=boxed recv.
        const emitToObjectOrThrow = (pfx) => {
            vm.mov(VReg.S0, VReg.A0);
            vm.mov(VReg.S1, VReg.A1);
            vm.mov(VReg.S2, VReg.A2);
            vm.shrImm(VReg.V0, VReg.S0, 48);
            vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq(pfx + "_nullish");
            vm.cmpImm(VReg.V0, 0x7FFB); vm.jne(pfx + "_to_ok");
            vm.label(pfx + "_nullish");
            throwTE("Cannot convert undefined or null to object");
            vm.label(pfx + "_to_ok");
        };

        // ── __defineGetter__(name, getter) / __defineSetter__(name, setter) ──
        const emitDefine = (label, isGetter) => {
            const pfx = isGetter ? "_aodg" : "_aods";
            const pack = isGetter ? PACK_GET : PACK_SET;
            const descKey = isGetter ? "get" : "set";
            vm.label(label);
            vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
            emitToObjectOrThrow(pfx);
            // IsCallable(fn) BEFORE ToPropertyKey (getter-non-callable: toStringCount===0)
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_is_callable");
            vm.cmpImm(VReg.RET, 0);
            vm.jne(pfx + "_callable");
            throwTE(isGetter
                ? "Object.prototype.__defineGetter__: getter must be callable"
                : "Object.prototype.__defineSetter__: setter must be callable");
            vm.label(pfx + "_callable");
            // ToPropertyKey
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_js_prop_key");
            vm.mov(VReg.S1, VReg.RET);
            // Proxy → build desc + _object_defineProperty_proxy; else packed define
            vm.emitMaskLoad(VReg.V1);
            vm.andMaskReg(VReg.V0, VReg.S0, VReg.V1);
            vm.cmpImm(VReg.V0, 0);
            vm.jeq(pfx + "_plain");
            vm.loadByte(VReg.V1, VReg.V0, 0);
            vm.cmpImm(VReg.V1, TYPE_PROXY);
            vm.jne(pfx + "_plain");
            // desc = { [get|set]: fn, enumerable: true, configurable: true }
            vm.call("_object_new");
            vm.movImm64(VReg.V1, 0x7ffd000000000000n);
            vm.or(VReg.S3, VReg.RET, VReg.V1);
            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, vm.asm.addString(descKey)); boxStr(VReg.A1);
            vm.mov(VReg.A2, VReg.S2);
            vm.call("_object_set");
            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, vm.asm.addString("enumerable")); boxStr(VReg.A1);
            vm.movImm64(VReg.A2, 0x7ff9000000000001n); // true
            vm.call("_object_set");
            vm.mov(VReg.A0, VReg.S3);
            vm.lea(VReg.A1, vm.asm.addString("configurable")); boxStr(VReg.A1);
            vm.movImm64(VReg.A2, 0x7ff9000000000001n);
            vm.call("_object_set");
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S1);
            vm.mov(VReg.A2, VReg.S3);
            vm.call("_object_defineProperty_proxy_or_throw");
            vm.jmp(pfx + "_done");
            vm.label(pfx + "_plain");
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S1);
            vm.movImm64(VReg.A2, 0x7ffb000000000000n); // value = undefined
            if (isGetter) {
                vm.mov(VReg.A3, VReg.S2); // get
                vm.mov(VReg.A4, VReg.A2); // set = undefined
            } else {
                vm.mov(VReg.A3, VReg.A2); // get = undefined
                vm.mov(VReg.A4, VReg.S2); // set
            }
            vm.movImm(VReg.A5, pack);
            vm.call("_object_define_property");
            vm.label(pfx + "_done");
            vm.lea(VReg.RET, "_js_undefined");
            vm.load(VReg.RET, VReg.RET, 0);
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        };
        emitDefine("_aref_obj_defineGetter", true);
        emitDefine("_aref_obj_defineSetter", false);

        // ── __lookupGetter__(name) / __lookupSetter__(name) ──
        const emitLookup = (label, field) => {
            const pfx = field === "get" ? "_aolg" : "_aols";
            vm.label(label);
            vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
            // A2 unused; emitToObject still saves it
            emitToObjectOrThrow(pfx);
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_js_prop_key");
            vm.mov(VReg.S1, VReg.RET); // normalized key
            // loop: desc = gOPD(O, key); if found return desc[field]; else O = getPrototypeOf(O)
            vm.label(pfx + "_loop");
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S1);
            vm.call("_object_getOwnPropertyDescriptor");
            vm.movImm64(VReg.V1, 0x7ffb000000000000n); // undefined
            vm.cmp(VReg.RET, VReg.V1);
            vm.jeq(pfx + "_next");
            // desc found: return desc.get / desc.set (data → undefined own miss → undefined)
            vm.mov(VReg.S2, VReg.RET); // desc
            vm.mov(VReg.A0, VReg.S2);
            vm.lea(VReg.A1, vm.asm.addString(field)); boxStr(VReg.A1);
            vm.call("_object_get");
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
            vm.label(pfx + "_next");
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_object_getPrototypeOf");
            vm.mov(VReg.S0, VReg.RET);
            vm.shrImm(VReg.V0, VReg.S0, 48);
            vm.cmpImm(VReg.V0, 0x7FFA); // null
            vm.jeq(pfx + "_miss");
            vm.cmpImm(VReg.V0, 0x7FFB); // undefined
            vm.jeq(pfx + "_miss");
            vm.jmp(pfx + "_loop");
            vm.label(pfx + "_miss");
            vm.lea(VReg.RET, "_js_undefined");
            vm.load(VReg.RET, VReg.RET, 0);
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        };
        emitLookup("_aref_obj_lookupGetter", "get");
        emitLookup("_aref_obj_lookupSetter", "set");
    }



}
