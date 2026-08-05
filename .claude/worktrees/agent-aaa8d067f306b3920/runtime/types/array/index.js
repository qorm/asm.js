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

        // 写入元素并递增 length（重新读取 data_ptr，增长后可能变化）
        vm.load(VReg.V0, VReg.S0, 8);  // length
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V2, VReg.V0, 3);
        vm.add(VReg.V2, VReg.V1, VReg.V2);
        vm.store(VReg.V2, 0, VReg.S1); // data[length] = value
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.S0, 8, VReg.V0);  // length++

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
    generateArrayPop() {
        const vm = this.vm;

        vm.label("_array_pop");
        vm.prologue(16, [VReg.S0, VReg.S1]);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr

        // 获取当前长度
        vm.load(VReg.S1, VReg.S0, 8);

        // 检查是否为空
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_pop_empty");

        // 减少长度
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.store(VReg.S0, 8, VReg.S1);

        // 获取最后一个元素: data_ptr + (length-1) * 8
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V0, VReg.S1, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_array_pop_empty");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
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

        vm.epilogue([VReg.S0], 0);
        vm.label("_array_get_oob");
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
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr
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

        // 预先检查 value 是否是 Number 对象
        // S4 = value 的数值（如果是 Number），否则为 0
        vm.movImm(VReg.S4, 0);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_indexOf_loop"); // null，跳过
        // 检查是否是原始 float64（非 NaN-boxing）
        vm.shrImm(VReg.V0, VReg.S1, 48); // V0 = 高 16 位
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_array_indexOf_loop"); // 原始 float，使用直接比较
        // 否则尝试作为 Number 对象处理：必须先脱壳成堆指针再读类型！
        // 原直接 load[S1,0]，但 S1 是装箱值(如字符串 0x7ffc|ptr) → 读 [0x7ffc..] 越界崩
        // （自举里 arr.indexOf("str") 类调用，字符串搜索值 → 崩根因）。
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.S1, VReg.V1); // V1 = 脱壳堆指针
        vm.load(VReg.V0, VReg.V1, 0); // 加载 value 的类型（字符串对象 type=6 < TYPE_INT8）
        vm.cmpImm(VReg.V0, TYPE_INT8);
        vm.jlt("_array_indexOf_loop"); // 不是 Number
        vm.cmpImm(VReg.V0, TYPE_FLOAT64);
        vm.jgt("_array_indexOf_loop"); // 不是 Number
        // 是 Number，加载其数值
        vm.load(VReg.S4, VReg.V1, 8);

        vm.label("_array_indexOf_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_array_indexOf_notfound");

        // 元素地址: data_ptr + i * 8
        vm.load(VReg.V0, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V1, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V1, VReg.V0, 0); // V1 = arr[i]

        // 第一步：直接指针比较(快路:interned 串/同 bits/同指针)
        vm.cmp(VReg.V1, VReg.S1);
        vm.jeq("_array_indexOf_found");

        // 第二步:=== 语义严格相等。此前只有指针 + Number 对象数值比较,**无字符串内容比**——
        // split/动态构造的堆串指针各异 → `"a-b-c".split("-").indexOf("b")`、
        // `["x","y"].indexOf(String.fromCharCode(121))` 恒 -1(字面量数组因串驻留同指针才命中)。
        // 调 _strict_eq(串按内容 _strcmp、Number 按值、NaN≠NaN)。S0-S3 经 _strict_eq 保存;
        // S2(索引)/S3(长度)跨调用存活;S4 不再需要(数值比较已并入 _strict_eq)。
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

        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = arr
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

        // value 是否 Number 对象 → S4 = 数值,否则 0（同 indexOf）
        vm.movImm(VReg.S4, 0);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_lastIndexOf_loop");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FF8);
        vm.jlt("_array_lastIndexOf_loop");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.S1, VReg.V1);
        vm.load(VReg.V0, VReg.V1, 0);
        vm.cmpImm(VReg.V0, TYPE_INT8);
        vm.jlt("_array_lastIndexOf_loop");
        vm.cmpImm(VReg.V0, TYPE_FLOAT64);
        vm.jgt("_array_lastIndexOf_loop");
        vm.load(VReg.S4, VReg.V1, 8);

        vm.label("_array_lastIndexOf_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jlt("_array_lastIndexOf_notfound"); // i < 0

        vm.load(VReg.V0, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V1, VReg.S2, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V1, VReg.V0, 0); // arr[i]

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

        // 直接指针比较
        vm.cmp(VReg.V1, VReg.S1);
        vm.jeq("_array_includes_true");

        // Number 值比较（S4 != 0 表示 search value 是 Number 对象）
        vm.cmpImm(VReg.S4, 0);
        vm.jeq("_array_includes_next");
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_array_includes_next");
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

        vm.emitMaskLoad(VReg.V0);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V0); // S0 = 裸数组指针
        vm.mov(VReg.S1, VReg.A1); // S1 = 分隔符（装箱字符串）

        vm.load(VReg.S2, VReg.S0, 8); // 长度 @8
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_array_join_empty");

        // S3 = 第一个元素 ToString（null/undefined → 空串,见 _arr_elem_boxed_str）
        vm.load(VReg.V0, VReg.S0, 24); // data_ptr
        vm.load(VReg.A0, VReg.V0, 0);  // elem[0]
        vm.call("_arr_elem_boxed_str");
        vm.mov(VReg.S3, VReg.RET);

        vm.movImm(VReg.S4, 1);
        vm.label("_array_join_loop");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_array_join_done");

        // S3 = S3 + sep
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strconcat");
        vm.mov(VReg.S3, VReg.RET);

        // S3 = S3 + ToString(elem[i])（null/undefined → 空串）
        vm.load(VReg.V1, VReg.S0, 24); // data_ptr
        vm.shl(VReg.V0, VReg.S4, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.push(VReg.S3); vm.push(VReg.S4);
        vm.call("_arr_elem_boxed_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.pop(VReg.S4); vm.pop(VReg.S3);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_strconcat");
        vm.mov(VReg.S3, VReg.RET);

        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_array_join_loop");

        vm.label("_array_join_done");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        vm.label("_array_join_empty");
        vm.lea(VReg.A0, "_str_empty");
        vm.call("_js_box_string");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // 元素值 → 装箱字符串;null(0x7FFA)/undefined(0x7FFB) → 空串(Array join 语义)。
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

    // _array_shift(A0 = boxed 数组) -> 移除并返回首元素(空则 undefined)。
    // live 布局:length@8 / data_ptr@24(元素=data_ptr+i*8)。旧 mutate.js 版是死代码
    // (未接 generate,stale 布局 length@0/内联)——shift 此前落空调用返 [object Object]。
    generateArrayShift() {
        const vm = this.vm;
        vm.label("_array_shift");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = 裸数组指针
        vm.load(VReg.S1, VReg.S0, 8);      // S1 = length
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_array_shift_empty");
        vm.load(VReg.S2, VReg.S0, 24);     // S2 = data_ptr
        vm.load(VReg.S3, VReg.S2, 0);      // S3 = removed = data[0]
        // data[i] = data[i+1] for i in 0..length-2
        vm.movImm(VReg.V0, 0);
        vm.subImm(VReg.V1, VReg.S1, 1);
        vm.label("_array_shift_loop");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_array_shift_done");
        vm.addImm(VReg.V2, VReg.V0, 1);
        vm.shl(VReg.V2, VReg.V2, 3);
        vm.add(VReg.V2, VReg.S2, VReg.V2); // &data[i+1]
        vm.load(VReg.V3, VReg.V2, 0);
        vm.shl(VReg.V2, VReg.V0, 3);
        vm.add(VReg.V2, VReg.S2, VReg.V2); // &data[i]
        vm.store(VReg.V2, 0, VReg.V3);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_array_shift_loop");
        vm.label("_array_shift_done");
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.store(VReg.S0, 8, VReg.S1);     // length--
        vm.mov(VReg.RET, VReg.S3);         // 返回 removed
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_array_shift_empty");
        vm.lea(VReg.RET, "_js_undefined");
        vm.load(VReg.RET, VReg.RET, 0);    // undefined 的值(非符号地址)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _array_unshift(A0 = boxed 数组, A1 = value) -> 新长度(JS number)。
    // 原地:_array_ensure_cap 扩容(头稳定、data_ptr@24 更新)→ 元素右移一位 →
    // data[0]=value → length++。返回值 = 新长度装箱为 double(scvtf+fmovToInt)。
    generateArrayUnshift() {
        const vm = this.vm;
        vm.label("_array_unshift");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_gc_remember"); // 分代写屏障(A0=容器;young 值写入可能为 old 的数组,老容器记入记忆集)
        vm.mov(VReg.S2, VReg.A1);          // S2 = value(先存,ensure_cap 会冲 A 寄存器)
        vm.emitMaskLoad(VReg.V4);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V4); // S0 = 裸数组指针
        vm.load(VReg.S1, VReg.S0, 8);      // S1 = length
        // 扩容到 length+1(原地,头指针 S0 稳定)
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S1, 1);
        vm.call("_array_ensure_cap");
        vm.load(VReg.V0, VReg.S0, 24);     // V0 = data_ptr(扩容后重载)
        // 右移:for i = length down to 1: data[i] = data[i-1]
        vm.mov(VReg.V1, VReg.S1);          // i = length
        vm.label("_array_unshift_loop");
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_array_unshift_insert");
        vm.subImm(VReg.V2, VReg.V1, 1);
        vm.shl(VReg.V3, VReg.V2, 3);
        vm.add(VReg.V3, VReg.V0, VReg.V3); // &data[i-1]
        vm.load(VReg.V3, VReg.V3, 0);
        vm.shl(VReg.V2, VReg.V1, 3);
        vm.add(VReg.V2, VReg.V0, VReg.V2); // &data[i]
        vm.store(VReg.V2, 0, VReg.V3);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_array_unshift_loop");
        vm.label("_array_unshift_insert");
        vm.store(VReg.V0, 0, VReg.S2);     // data[0] = value
        vm.addImm(VReg.S1, VReg.S1, 1);    // 新长度
        vm.store(VReg.S0, 8, VReg.S1);     // length = 新长度
        // 返回新长度(裸 int → double JS number)
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
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
    generateArraySpreadInto() {
        const vm = this.vm;
        const TYPE_MAP = 4;
        const TYPE_SET = 5;
        vm.label("_array_spread_into");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // arr(每次 push 后更新)
        vm.mov(VReg.S1, VReg.A1); // src(boxed)

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
        vm.load(VReg.A1, VReg.S2, 0);  // value
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.S2, VReg.S2, 8);  // next
        vm.jmp("_array_spread_set_loop");

        // ---- Map: head@16, node key@0/value@8/next@16;每条目 push [k,v] ----
        vm.label("_array_spread_map");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.S2, VReg.V0, 16); // node = head
        vm.label("_array_spread_map_loop");
        vm.cmpImm(VReg.S2, 0);
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
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
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
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFF); // next 须是函数
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
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_push");
        vm.mov(VReg.S0, VReg.RET);
        vm.jmp("_array_spread_iter_loop");

        vm.label("_array_spread_done");
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

        // arr.indexOf(value[, from]):A0=arr, A1=value(装箱透传), A2=boxed from → 裸 from(缺省0)
        vm.label("_aref_arr_indexOf");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.A2);
        vm.call("_aref_argint");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_indexOf"); // RET = 裸 int 下标/-1
        vm.scvtf(0, VReg.RET);      // 裸 int → 装箱 float64 数字(同静态派发出口)
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

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
        // 装箱函数脱壳→magic 判闭包(fnptr@8,S0=闭包)/裸函数(S0=0);this=undefined(A5)。
        vm.label("_aref_invoke_cb");
        vm.prologue(0, [VReg.S0]); // 保存 S0(闭包会占用;调用者的 S0 须还原)
        vm.mov(VReg.V6, VReg.A3);
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
        vm.movImm(VReg.S0, 0);          // 裸函数:无闭包
        vm.label("_aref_icb_do");
        vm.movImm64(VReg.A5, UNDEF);    // this = undefined
        vm.setCallArgcImm(3, VReg.V0, VReg.V1); // [argc ABI] callback(elem, idx, arr)
        vm.callIndirect(VReg.V6);       // callback(A0,A1,A2)
        vm.epilogue([VReg.S0], 0);

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

        // arr.forEach(cb):A0=arr(boxed), A1=callback → undefined。逐元素调 cb(element, i, arr)。
        // GC:arr/cb 存 callee-saved(prologue 落栈,GC 扫栈可见);i/length 是裸 int;无增长结果。
        vm.label("_array_forEach_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // arr(boxed)
        vm.mov(VReg.S1, VReg.A1); // callback
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // length(裸 int)
        vm.movImm(VReg.S3, 0);     // i
        vm.label("_fe_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_fe_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");     // RET = element(boxed)
        vm.mov(VReg.A0, VReg.RET); // arg0 = element
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);  // arg1 = 装箱 index
        vm.mov(VReg.A2, VReg.S0);  // arg2 = arr
        vm.mov(VReg.A3, VReg.S1);  // callback
        vm.call("_aref_invoke_cb");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_fe_loop");
        vm.label("_fe_done");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // arr.map(cb) → 新数组[cb(el,i,arr)]。结果(S4)存 callee-saved(落栈,GC 扫栈可见);
        // _array_push 可能重分配 data 区、返回新头,故每轮回写 S4。
        vm.label("_array_map_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S4, VReg.RET); // result(裸头)
        vm.movImm(VReg.S3, 0);
        vm.label("_map_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_map_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);
        vm.mov(VReg.A3, VReg.S1);
        vm.call("_aref_invoke_cb"); // RET = mapped
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_array_push");
        vm.mov(VReg.S4, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_map_loop");
        vm.label("_map_done");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1); // 装箱 0x7FFE
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // arr.filter(cb) → 新数组[cb 真值的 el]。element 存栈槽 [SP+0](GC 扫栈可见)以跨回调
        // 保活并在真值时 push;_to_boolean 判真值(RET≠0)。
        vm.label("_array_filter_rt");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S4, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_filt_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_filt_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.store(VReg.SP, 0, VReg.RET); // 存 element(跨回调保活)
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);
        vm.mov(VReg.A3, VReg.S1);
        vm.call("_aref_invoke_cb"); // RET = 谓词结果
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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 16);

        // arr.some(cb) → 任一 cb 真值 → true,否则 false(短路)。无结果数组。
        vm.label("_array_some_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_some_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_some_false");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);
        vm.mov(VReg.A3, VReg.S1);
        vm.call("_aref_invoke_cb");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_some_true");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_some_loop");
        vm.label("_some_true");
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_some_false");
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // arr.every(cb) → 全部 cb 真值 → true,否则 false(短路)。
        vm.label("_array_every_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_every_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_every_true");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);
        vm.mov(VReg.A3, VReg.S1);
        vm.call("_aref_invoke_cb");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_every_false");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_every_loop");
        vm.label("_every_true");
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_every_false");
        vm.lea(VReg.V0, "_js_false");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // 4 实参回调调用器(reduce 用):A0-A3=cb 实参(acc,cur,idx,arr), A4=callback → RET。
        // 同 _aref_invoke_cb 的 magic 派发,唯 callback 在 A4(A0-A3 留给回调实参)。
        vm.label("_aref_invoke_cb4");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.V6, VReg.A4);
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
        vm.movImm(VReg.S0, 0);
        vm.label("_aref_icb4_do");
        vm.movImm64(VReg.A5, UNDEF);
        vm.setCallArgcImm(4, VReg.V0, VReg.V1); // [argc ABI] callback(acc, cur, idx, arr)
        vm.callIndirect(VReg.V6);
        vm.epilogue([VReg.S0], 0);

        // arr.reduce(cb[, seed]):A0=arr, A1=cb, A2=seed(缺省 JS_UNDEFINED)。seed 须在
        // _array_length(冲 A2)前存入 S4。无 seed(S4===undefined)→ acc=arr[0]、i 从 1;
        // 有 seed → acc=seed、i 从 0。空数组且无 seed → undefined(node 抛,此处宽松,记偏差)。
        // acc(S4)callee-saved(落栈,GC 扫栈可见)跨回调保活。回调 cb(acc,cur,idx,arr)。
        vm.label("_array_reduce_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2); // seed(先存,_array_length 会冲 A2)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7ffb); // seed===undefined?
        vm.jeq("_reduce_noseed");
        vm.movImm(VReg.S3, 0); // 有 seed:i=0
        vm.jmp("_reduce_loop");
        vm.label("_reduce_noseed");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_reduce_empty");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET); // acc=arr[0]
        vm.movImm(VReg.S3, 1);
        vm.label("_reduce_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_reduce_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A1, VReg.RET); // cur=element
        vm.mov(VReg.A0, VReg.S4);  // acc
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A2, 0);  // idx boxed
        vm.mov(VReg.A3, VReg.S0);  // arr
        vm.mov(VReg.A4, VReg.S1);  // callback
        vm.call("_aref_invoke_cb4");
        vm.mov(VReg.S4, VReg.RET); // acc=result
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_reduce_loop");
        vm.label("_reduce_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_reduce_empty");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);

        // arr.reduceRight(cb[, seed]):从末尾向前。无 seed → acc=arr[len-1]、i 从 len-2;
        // 有 seed → acc=seed、i 从 len-1。i<0 结束。
        vm.label("_array_reduceRight_rt");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S4, VReg.A2);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S4, 48);
        vm.cmpImm(VReg.V0, 0x7ffb);
        vm.jeq("_rredr_noseed");
        vm.subImm(VReg.S3, VReg.S2, 1); // 有 seed:i=len-1
        vm.jmp("_rredr_loop");
        vm.label("_rredr_noseed");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_rredr_empty");
        vm.subImm(VReg.S3, VReg.S2, 1);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET); // acc=arr[len-1]
        vm.subImm(VReg.S3, VReg.S3, 1); // i=len-2
        vm.label("_rredr_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_rredr_done"); // i<0
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A2, 0);
        vm.mov(VReg.A3, VReg.S0);
        vm.mov(VReg.A4, VReg.S1);
        vm.call("_aref_invoke_cb4");
        vm.mov(VReg.S4, VReg.RET);
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_rredr_loop");
        vm.label("_rredr_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_rredr_empty");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    generate() {
        this.generateArefGeneric();
        this.generateArefIntWrappers();
        this.generateArefCallbackMethods();
        this.generateSpreadCall0();
        this.generateArraySpreadInto();
        this.generateArrayEnsureCap();
        this.generateArrayPush();
        this.generateArrayPop();
        this.generateArrayGet();
        this.generateArraySet();
        this.generateArrayLength();
        this.generateArrayAt();
        this.generateArrayIndexOf();
        this.generateArrayLastIndexOf();
        this.generateArrayIncludes();
        this.generateArraySlice();
        this.generateArrayNewWithSize();
        this.generateArrayWith();
        this.generateArrayToString();
        this.generateArrayConcat();
        this.generateArrayJoin();
        this.generateArrayReverse();
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
        // next 闭包块(40B)
        vm.movImm(VReg.A0, 40);
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
        // 耗尽:{value: undefined, done: true}
        vm.label("_arriter_done");
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
}
