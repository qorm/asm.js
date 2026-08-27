// asm.js 运行时 - TypedArray 和 ArrayBuffer 类型
// 支持所有 JavaScript TypedArray 类型和 ArrayBuffer
//
// TypedArray 与普通 Array 的区别：
// - Array: 元素是 boxed 值（带类型头部），每个元素 8 字节指针
// - TypedArray: 元素是 raw 值（无头部），元素大小取决于类型
//
// ArrayBuffer 布局:
// [type:8 | byteLength:8 | buffer...]
//  +0: TYPE_ARRAY_BUFFER (12)
//  +8: 字节长度
// +16: 原始数据缓冲区
//
// TypedArray 布局 (type 直接标识数组类型):
// [type:8 | length:8 | buffer...]
//  +0: TYPE_INT8_ARRAY / TYPE_FLOAT64_ARRAY 等
//  +8: 元素数量
// +16: 原始数据缓冲区

import { VReg } from "../../../vm/registers.js";
import { TYPE_ARRAY, TYPE_ARRAY_BUFFER, TYPE_DATA_VIEW, TYPE_INT8_ARRAY, TYPE_INT16_ARRAY, TYPE_INT32_ARRAY, TYPE_INT64_ARRAY, TYPE_UINT8_ARRAY, TYPE_UINT16_ARRAY, TYPE_UINT32_ARRAY, TYPE_UINT64_ARRAY, TYPE_UINT8_CLAMPED_ARRAY, TYPE_FLOAT32_ARRAY, TYPE_FLOAT64_ARRAY } from "../../core/types.js";

// 重新导出类型常量
export { TYPE_INT8_ARRAY, TYPE_INT16_ARRAY, TYPE_INT32_ARRAY, TYPE_INT64_ARRAY, TYPE_UINT8_ARRAY, TYPE_UINT16_ARRAY, TYPE_UINT32_ARRAY, TYPE_UINT64_ARRAY, TYPE_UINT8_CLAMPED_ARRAY, TYPE_FLOAT32_ARRAY, TYPE_FLOAT64_ARRAY };

// TypedArray 名称到类型的映射
export const TypedArrayTypes = {
    Int8Array: TYPE_INT8_ARRAY,
    Int16Array: TYPE_INT16_ARRAY,
    Int32Array: TYPE_INT32_ARRAY,
    BigInt64Array: TYPE_INT64_ARRAY,
    Uint8Array: TYPE_UINT8_ARRAY,
    Uint16Array: TYPE_UINT16_ARRAY,
    Uint32Array: TYPE_UINT32_ARRAY,
    BigUint64Array: TYPE_UINT64_ARRAY,
    Uint8ClampedArray: TYPE_UINT8_CLAMPED_ARRAY,
    Float32Array: TYPE_FLOAT32_ARRAY,
    Float64Array: TYPE_FLOAT64_ARRAY,
};

// 类型到元素大小的映射
export const TypedArrayElemSize = {
    [TYPE_INT8_ARRAY]: 1,
    [TYPE_UINT8_ARRAY]: 1,
    [TYPE_UINT8_CLAMPED_ARRAY]: 1,
    [TYPE_INT16_ARRAY]: 2,
    [TYPE_UINT16_ARRAY]: 2,
    [TYPE_INT32_ARRAY]: 4,
    [TYPE_UINT32_ARRAY]: 4,
    [TYPE_FLOAT32_ARRAY]: 4,
    [TYPE_INT64_ARRAY]: 8,
    [TYPE_UINT64_ARRAY]: 8,
    [TYPE_FLOAT64_ARRAY]: 8,
};

// TypedArray/ArrayBuffer 头部大小 (统一 16 字节)
export const TYPED_ARRAY_HEADER = 16;
export const ARRAY_BUFFER_HEADER = 40; // [Design B] type@0/byteLength@8/data_ptr@16/owner@24/maxByteLength@32

// ==================== ArrayBuffer ====================

export class ArrayBufferGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
    }

    // [Design B] ArrayBuffer 布局(40B 头):
    //   +0  type (TYPE_ARRAY_BUFFER=12)
    //   +8  byteLength
    //   +16 data_ptr —— 实际字节的地址。own-data buffer = self+40;wrapper(ta.buffer)
    //        = 被别名内存地址(如 ta+16),使 DataView/多视图与源共享同一段内存。
    //   +24 owner —— wrapper 的源对象(GC 根,防其被回收);own-data = 0。
    //   +32 maxByteLength —— resizable buffer 的上限(0 = 不可 resize)。可 resize 的
    //        buffer 一次按 max 分配,resize 只改 byteLength(数据地址恒定,已有视图不失效)。
    //   +40.. own-data 内联字节(仅 own-data buffer 用)。
    // 一切读写经 data_ptr(_arraybuffer_data_ptr),故 own/wrapper 统一。

    // _arraybuffer_new(byteLength) -> own-data ArrayBuffer 指针
    generateNew() {
        const vm = this.vm;

        vm.label("_arraybuffer_new");
        vm.prologue(16, [VReg.S0]);

        vm.mov(VReg.S0, VReg.A0); // byteLength

        // 总大小: 32 (header) + byteLength
        vm.addImm(VReg.A0, VReg.S0, ARRAY_BUFFER_HEADER);
        vm.call("_alloc");
        vm.mov(VReg.V1, VReg.RET);

        // 头部
        vm.movImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.store(VReg.V1, 0, VReg.V0);
        vm.store(VReg.V1, 8, VReg.S0);            // byteLength
        vm.addImm(VReg.V0, VReg.V1, ARRAY_BUFFER_HEADER); // data_ptr = self + 32
        vm.store(VReg.V1, 16, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V1, 24, VReg.V0);           // owner = 0(own-data)
        // maxByteLength = -1 表「不可 resize」。不能用 0 当哨兵:
        // `new ArrayBuffer(0, {maxByteLength: 0})` 是合法的**可 resize** 空 buffer
        // (test262 harness 的 makeGrownArrayBuffer 对空 TA 正是这样建的)。
        vm.movImm(VReg.V0, -1);
        vm.store(VReg.V1, 32, VReg.V0);

        vm.mov(VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0], 16);
    }

    // _arraybuffer_new_max(byteLength, maxByteLength) -> resizable own-data ArrayBuffer
    // 一次按 max 分配(resize 只改 byteLength):data_ptr 恒定 → 已建视图/DataView 不失效。
    generateNewMax() {
        const vm = this.vm;
        vm.label("_arraybuffer_new_max");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // byteLength
        vm.mov(VReg.S1, VReg.A1); // maxByteLength
        // max < byteLength → 按 byteLength 兜底(编译期已校验,运行时防御)
        vm.cmp(VReg.S1, VReg.S0);
        vm.jge("_abnm_ok");
        vm.mov(VReg.S1, VReg.S0);
        vm.label("_abnm_ok");
        vm.addImm(VReg.A0, VReg.S1, ARRAY_BUFFER_HEADER);
        vm.call("_alloc");
        vm.mov(VReg.V1, VReg.RET);
        vm.movImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.store(VReg.V1, 0, VReg.V0);
        vm.store(VReg.V1, 8, VReg.S0);
        vm.addImm(VReg.V0, VReg.V1, ARRAY_BUFFER_HEADER);
        vm.store(VReg.V1, 16, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V1, 24, VReg.V0);
        vm.store(VReg.V1, 32, VReg.S1);  // maxByteLength(>0 即 resizable)
        // 全区清零(alloc 复用内存不清零;规范要求新字节为 0)
        vm.load(VReg.V0, VReg.V1, 16);
        vm.movImm(VReg.V2, 0);
        vm.label("_abnm_zero");
        vm.cmp(VReg.V2, VReg.S1);
        vm.jge("_abnm_zdone");
        vm.add(VReg.A0, VReg.V0, VReg.V2);
        vm.movImm(VReg.A1, 0);
        vm.storeByte(VReg.A0, 0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_abnm_zero");
        vm.label("_abnm_zdone");
        vm.mov(VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _arraybuffer_maxbytelength(buf) -> maxByteLength@32(-1 = 不可 resize/非 buffer)
    generateMaxByteLength() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_arraybuffer_maxbytelength");
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_abmx_ptr");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_abmx_zero");
        vm.label("_abmx_ptr");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 4095);
        vm.jle("_abmx_zero");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jne("_abmx_zero");
        vm.load(VReg.RET, VReg.V0, 32);
        vm.ret();
        vm.label("_abmx_zero");
        vm.movImm(VReg.RET, -1);
        vm.ret();
    }

    // _arraybuffer_maxbytelength_prop(buf) -> get maxByteLength 的**属性语义**:
    // 不可 resize 的 buffer 返回 byteLength(规范如此,非 0);非 buffer 返 0。
    generateMaxByteLengthProp() {
        const vm = this.vm;
        vm.label("_arraybuffer_maxbytelength_prop");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_arraybuffer_maxbytelength");
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_abmxp_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_arraybuffer_bytelength");
        vm.label("_abmxp_done");
        vm.epilogue([VReg.S0], 16);
    }

    // _arraybuffer_resize(buf, newByteLength) -> undefined
    // 不可 resize(max=0)或非 buffer → TypeError;newLen ∉ [0,max] → RangeError。
    // 增长部分清零(规范:新字节为 0);data_ptr 不变,已有视图/DataView 继续可用。
    generateResize() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_arraybuffer_resize");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 buffer
        vm.mov(VReg.S1, VReg.A1);          // newLen(int)
        vm.cmpImm(VReg.S0, 4095);
        vm.jle("_abrs_type");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jne("_abrs_type");
        vm.load(VReg.S2, VReg.S0, 32);     // max(-1 = 不可 resize)
        vm.cmpImm(VReg.S2, 0);
        vm.jlt("_abrs_type");              // 非 resizable
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_abrs_range");
        vm.cmp(VReg.S1, VReg.S2);
        vm.jgt("_abrs_range");
        // 增长区清零:[oldLen, newLen)
        vm.load(VReg.V2, VReg.S0, 8);      // oldLen
        vm.load(VReg.V0, VReg.S0, 16);     // data_ptr
        vm.label("_abrs_zero");
        vm.cmp(VReg.V2, VReg.S1);
        vm.jge("_abrs_zdone");
        vm.add(VReg.A0, VReg.V0, VReg.V2);
        vm.movImm(VReg.A1, 0);
        vm.storeByte(VReg.A0, 0, VReg.A1);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_abrs_zero");
        vm.label("_abrs_zdone");
        vm.store(VReg.S0, 8, VReg.S1);     // byteLength = newLen
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_track_update");       // 长度跟踪视图跟随新 byteLength
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_abrs_type");
        vm.lea(VReg.A0, vm.asm.addString("ArrayBuffer.prototype.resize called on non-resizable ArrayBuffer"));
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error");
        vm.label("_abrs_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid ArrayBuffer resize length"));
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // DetachArrayBuffer:data_ptr@16==0 为 detached 哨兵(own-data 的 data_ptr 恒
    // 为 self+40 ≠ 0;空 buffer 同样)。byteLength=0、maxByteLength=-1,使
    // byteLength/maxByteLength/resizable 访问器与 resize 自然落到规范值
    // (0 / 0 / false / TypeError),不必每处再判。跟踪视图经 _ta_track_update
    // 把 length@8 回填为 0;固定长度视图仍靠 _ta_is_detached 认 buffer 哨兵。
    generateDetach() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        const STR_TAG = 0x7ffc000000000000n;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, MASK); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, STR_TAG); vm.or(reg, reg, VReg.V1);
        };

        // _ta_is_detached(A0=TA 装箱/裸) -> RET=0/1。仅用 A0/RET/V5/V6,
        // 避开 x64 上 V1≡A3/V2≡A2 毁调用方实参。buffer@24==0(内联未物化
        // wrapper)视为未 detach;$DETACHBUFFER(ta.buffer) 会先建 wrapper。
        vm.label("_ta_is_detached");
        vm.shrImm(VReg.V5, VReg.A0, 48);
        vm.cmpImm(VReg.V5, 0);
        vm.jeq("_taid_ptr");
        vm.cmpImm(VReg.V5, 0x7FFD);
        vm.jne("_taid_no");
        vm.label("_taid_ptr");
        vm.movImm64(VReg.V6, MASK);
        vm.and(VReg.V5, VReg.A0, VReg.V6);
        vm.cmpImm(VReg.V5, 4095);
        vm.jle("_taid_no");
        vm.load(VReg.V6, VReg.V5, 24);      // buffer@24
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_taid_no");
        vm.movImm64(VReg.V5, MASK);
        vm.and(VReg.V6, VReg.V6, VReg.V5);
        vm.cmpImm(VReg.V6, 4095);
        vm.jle("_taid_no");
        vm.loadByte(VReg.V5, VReg.V6, 0);
        vm.cmpImm(VReg.V5, TYPE_ARRAY_BUFFER);
        vm.jne("_taid_no");
        vm.load(VReg.V5, VReg.V6, 16);      // data_ptr
        vm.cmpImm(VReg.V5, 0);
        vm.jne("_taid_no");
        vm.movImm(VReg.RET, 1);
        vm.ret();
        vm.label("_taid_no");
        vm.movImm(VReg.RET, 0);
        vm.ret();

        // _ta_is_oob(A0=TA 装箱/裸) -> 1/0。IsTypedArrayOutOfBounds:
        // byteOffset + [[ArrayLength]]*elemSize > buffer.[[ByteLength]]。
        // 固定长度视图在 rab.resize 缩小时仍保留旧 length@8;越界后读→undefined、
        // 写→no-op(comparefn-shrink / SortIndexedProperties 写回依赖此)。
        // 元素宽度内联;byteOffset 经 _ta_byteoffset(禁盲读 @32:内联 TA 的 @32
        // 是数据区首元素,DataView 写入后会被误当成巨大 offset → 假 OOB)。
        vm.label("_ta_is_oob");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.S0, 4095);
        vm.jle("_taio_no");
        vm.load(VReg.V0, VReg.S0, 24); // buffer@24
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_taio_no"); // 内联 → 永不因 resize OOB
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S1, VReg.V0, VReg.V1);
        vm.cmpImm(VReg.S1, 4095);
        vm.jle("_taio_no");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.jne("_taio_no");
        vm.load(VReg.V0, VReg.S1, 16); // data_ptr==0 → detached,不算本路径
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_taio_no");
        vm.load(VReg.S2, VReg.S1, 8); // buffer.byteLength
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_byteoffset"); // 规范 [[ByteOffset]](内联→0)
        vm.mov(VReg.V1, VReg.RET);
        vm.cmp(VReg.V1, VReg.S2);
        vm.jgt("_taio_yes"); // offset > byteLength
        // elemSize from type@0
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.movImm(VReg.V2, 8); // default
        vm.cmpImm(VReg.V0, TYPE_INT8_ARRAY); vm.jeq("_taio_e1");
        vm.cmpImm(VReg.V0, TYPE_UINT8_ARRAY); vm.jeq("_taio_e1");
        vm.cmpImm(VReg.V0, TYPE_UINT8_CLAMPED_ARRAY); vm.jeq("_taio_e1");
        vm.cmpImm(VReg.V0, TYPE_INT16_ARRAY); vm.jeq("_taio_e2");
        vm.cmpImm(VReg.V0, TYPE_UINT16_ARRAY); vm.jeq("_taio_e2");
        vm.cmpImm(VReg.V0, TYPE_INT32_ARRAY); vm.jeq("_taio_e4");
        vm.cmpImm(VReg.V0, TYPE_UINT32_ARRAY); vm.jeq("_taio_e4");
        vm.cmpImm(VReg.V0, TYPE_FLOAT32_ARRAY); vm.jeq("_taio_e4");
        vm.jmp("_taio_emul");
        vm.label("_taio_e1"); vm.movImm(VReg.V2, 1); vm.jmp("_taio_emul");
        vm.label("_taio_e2"); vm.movImm(VReg.V2, 2); vm.jmp("_taio_emul");
        vm.label("_taio_e4"); vm.movImm(VReg.V2, 4);
        vm.label("_taio_emul");
        vm.store(VReg.SP, 0, VReg.V1); // 保 offset(_ta_byteoffset 后 V1 可能打脏)
        vm.load(VReg.V0, VReg.S0, 8); // [[ArrayLength]]
        vm.mul(VReg.V0, VReg.V0, VReg.V2); // len * elemSize
        vm.load(VReg.V1, VReg.SP, 0);
        vm.add(VReg.V0, VReg.V0, VReg.V1); // + offset
        vm.cmp(VReg.V0, VReg.S2);
        vm.jgt("_taio_yes");
        vm.label("_taio_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
        vm.label("_taio_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        // _tam_throw_if_detached(A0=TA):ValidateTypedArray 的边界检查 —
        // detached 或 IsTypedArrayOutOfBounds → TypeError;否则 A0/RET 还原。
        // attached+in-bounds 路径不写 A1..A5。
        vm.label("_tam_throw_if_detached");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_ta_is_detached");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tam_tid_throw");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_tam_tid_ok");
        vm.label("_tam_tid_throw");
        vm.lea(VReg.A0, vm.asm.addString("Cannot perform TypedArray operation on a detached or out-of-bounds ArrayBuffer"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.label("_tam_tid_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);

        // _ta_throw_detached:无参 TypeError(AB.slice / DataView / new TA(detached))。
        vm.label("_ta_throw_detached");
        vm.lea(VReg.A0, vm.asm.addString("Cannot operate on a detached ArrayBuffer"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");

        // _arraybuffer_detach(A0=buffer) -> undefined。非 AB → TypeError。
        vm.label("_arraybuffer_detach");
        vm.prologue(16, [VReg.S0]);
        vm.movImm64(VReg.V5, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V5);
        vm.cmpImm(VReg.S0, 4095);
        vm.jle("_abd_type");
        vm.loadByte(VReg.V5, VReg.S0, 0);
        vm.cmpImm(VReg.V5, TYPE_ARRAY_BUFFER);
        vm.jne("_abd_type");
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.S0, 16, VReg.V0);     // data_ptr = 0(哨兵)
        vm.store(VReg.S0, 8, VReg.V0);      // byteLength = 0
        vm.movImm(VReg.V0, -1);
        vm.store(VReg.S0, 32, VReg.V0);     // maxByteLength = -1(不可 resize)
        // detach 不改视图 [[ArrayLength]](length@8):ValidateTypedArray 之后捕获的
        // len 在 ToInteger(fromIndex)/ToString(sep) 里 detach 后仍用于搜索/join。
        // length 访问器经 wrap "zero" / _typed_array_length 认哨兵返 0。
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0], 16);
        vm.label("_abd_type");
        vm.lea(VReg.A0, vm.asm.addString("detachArrayBuffer called on non-ArrayBuffer"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.epilogue([VReg.S0], 16);
    }

    // ==================== 长度跟踪视图(resizable ArrayBuffer)====================
    // `new TA(rab)`(不给 length)是 length-tracking 视图:rab.resize 后 ta.length 必须
    // 跟着变。视图头是 32B 定长(内联数据紧随其后),加不了字段;读 length@8 的点又遍布
    // 运行时/编译器两侧。故改为**登记表 + resize 时回填**:登记项挂在数据段链表
    // (位于 _data_gc_end 前 → GC 根,与 _closure_props_registry 同法),resize 末尾按
    // buffer 匹配把各视图的 length@8 改成 (byteLength - byteOffset) / elemSize(负则 0)。
    // 节点 40B:{next@0, view@8, buf@16, byteOffset@24, elemSize@32}。
    generateTrackTable() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.asm.addDataLabel("_ta_track_head");
        vm.asm.addDataQword(0);

        // _ta_track_add(A0=裸视图, A1=buffer(裸/装箱), A2=byteOffset, A3=elemSize)
        // 仅登记 resizable buffer 的视图(max@32>0);其余直接返回(零开销、表不增长)。
        vm.label("_ta_track_add");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S1, VReg.A1, VReg.V1);  // 裸 buffer
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.cmpImm(VReg.S1, 4095);
        vm.jle("_tatr_skip");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.jne("_tatr_skip");
        vm.load(VReg.V0, VReg.S1, 32);      // maxByteLength(-1 = 不可 resize)
        vm.cmpImm(VReg.V0, 0);
        vm.jlt("_tatr_skip");
        vm.movImm(VReg.A0, 40);
        vm.call("_alloc");
        vm.mov(VReg.V2, VReg.RET);
        vm.lea(VReg.V0, "_ta_track_head");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.V2, 0, VReg.V1);      // next = 旧表头
        vm.store(VReg.V2, 8, VReg.S0);      // view
        vm.store(VReg.V2, 16, VReg.S1);     // buf
        vm.store(VReg.V2, 24, VReg.S2);     // byteOffset
        vm.store(VReg.V2, 32, VReg.S3);     // elemSize
        vm.lea(VReg.V0, "_ta_track_head");
        vm.store(VReg.V0, 0, VReg.V2);
        vm.label("_tatr_skip");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // _ta_track_update(A0=裸 buffer):按新 byteLength 回填该 buffer 的所有跟踪视图。
        vm.label("_ta_track_update");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.load(VReg.S1, VReg.S0, 8);       // 新 byteLength
        vm.lea(VReg.V0, "_ta_track_head");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.label("_tatu_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_tatu_done");
        vm.load(VReg.V0, VReg.S2, 16);      // node.buf
        vm.cmp(VReg.V0, VReg.S0);
        vm.jne("_tatu_next");
        vm.load(VReg.V1, VReg.S2, 24);      // byteOffset
        vm.sub(VReg.V1, VReg.S1, VReg.V1);  // 可用字节
        vm.cmpImm(VReg.V1, 0);
        vm.jge("_tatu_pos");
        vm.movImm(VReg.V1, 0);              // 越界 → 长度 0
        vm.label("_tatu_pos");
        vm.load(VReg.V2, VReg.S2, 32);      // elemSize
        vm.mov(VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.V2);
        vm.call("_ta_track_div");           // RET = 可用字节 / elemSize
        vm.load(VReg.V0, VReg.S2, 8);       // view
        vm.store(VReg.V0, 8, VReg.RET);     // view.length = 新元素数
        vm.label("_tatu_next");
        vm.load(VReg.S2, VReg.S2, 0);       // next
        vm.jmp("_tatu_loop");
        vm.label("_tatu_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);

        // _ta_track_div(A0=字节数, A1=元素字节(1/2/4/8)) -> 元素数(移位除,避免依赖 udiv)
        vm.label("_ta_track_div");
        vm.cmpImm(VReg.A1, 1);
        vm.jeq("_tatd_1");
        vm.cmpImm(VReg.A1, 2);
        vm.jeq("_tatd_2");
        vm.cmpImm(VReg.A1, 4);
        vm.jeq("_tatd_4");
        vm.shrImm(VReg.RET, VReg.A0, 3);
        vm.ret();
        vm.label("_tatd_1");
        vm.mov(VReg.RET, VReg.A0);
        vm.ret();
        vm.label("_tatd_2");
        vm.shrImm(VReg.RET, VReg.A0, 1);
        vm.ret();
        vm.label("_tatd_4");
        vm.shrImm(VReg.RET, VReg.A0, 2);
        vm.ret();
    }

    // _arraybuffer_wrap(dataPtr, byteLength, owner) -> wrapper ArrayBuffer(别名 dataPtr)
    // 供 ta.buffer:data_ptr 指向源(ta 内联数据),owner=源对象(GC 根)。无 own-data 区。
    generateWrap() {
        const vm = this.vm;
        vm.label("_arraybuffer_wrap");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // dataPtr
        vm.mov(VReg.S1, VReg.A1); // byteLength
        vm.mov(VReg.S2, VReg.A2); // owner
        vm.movImm(VReg.A0, ARRAY_BUFFER_HEADER); // 仅头部(无 own-data)
        vm.call("_alloc");
        vm.movImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S1);   // byteLength
        vm.store(VReg.RET, 16, VReg.S0);  // data_ptr = 别名地址
        vm.store(VReg.RET, 24, VReg.S2);  // owner
        vm.movImm(VReg.V1, -1);
        vm.store(VReg.RET, 32, VReg.V1);  // maxByteLength = -1(wrapper 不可 resize)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // _arraybuffer_bytelength(buf) -> byteLength
    // [guard] 仅当实参确实是 ArrayBuffer 块时读 byteLength@8;否则返 0。
    // 原实现无条件 `load [A0+8]`:`new DataView(5)` 的缺省 byteLength 计算把 NaN-boxed
    // 双精度(高16=0x4014)当地址解引用 → SIGSEGV(test262 TA/DataView 崩溃簇)。
    // 判据:tag ∈ {0(裸指针), 0x7FFD(装箱对象)} 且脱壳后 >4095(挡小整数/空页)
    // 且头字节 == TYPE_ARRAY_BUFFER。
    generateByteLength() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_arraybuffer_bytelength");
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_abl_ptr");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_abl_zero");
        vm.label("_abl_ptr");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 4095);
        vm.jle("_abl_zero");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jne("_abl_zero");
        vm.load(VReg.RET, VReg.V0, 8);
        vm.ret();
        vm.label("_abl_zero");
        vm.movImm(VReg.RET, 0);
        vm.ret();
    }

    // _arraybuffer_data_ptr(buf) -> data_ptr(@16)
    generateDataPtr() {
        const vm = this.vm;
        vm.label("_arraybuffer_data_ptr");
        vm.load(VReg.RET, VReg.A0, 16);
        vm.ret();
    }

    // _arraybuffer_slice(buf, start, end) -> 新 own-data ArrayBuffer(拷贝 [start,end) 字节)
    generateSlice() {
        const vm = this.vm;

        vm.label("_arraybuffer_slice");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        // 脱壳;detached(data_ptr==0) → TypeError(规范 ArrayBuffer.prototype.slice 步骤 2)。
        // 只用 V5 作 MASK,避开 x64 V2≡A2 毁 end。
        vm.movImm64(VReg.V5, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V5);
        vm.load(VReg.S0, VReg.A0, 16); // 源 data_ptr
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_abs_detached");
        vm.mov(VReg.S1, VReg.A1);      // start
        vm.mov(VReg.S2, VReg.A2);      // end
        vm.load(VReg.S3, VReg.A0, 8);  // byteLength(临时用 S3 作 len)

        // [spec] 归一 start/end:<0 加 len;夹到 [0,len]。防越界读(如 slice(0,1e6))。
        vm.cmpImm(VReg.S1, 0); vm.jge("_abs_s1"); vm.add(VReg.S1, VReg.S1, VReg.S3); vm.label("_abs_s1");
        vm.cmpImm(VReg.S1, 0); vm.jge("_abs_s2"); vm.movImm(VReg.S1, 0); vm.label("_abs_s2");
        vm.cmp(VReg.S1, VReg.S3); vm.jle("_abs_s3"); vm.mov(VReg.S1, VReg.S3); vm.label("_abs_s3");
        vm.cmpImm(VReg.S2, 0); vm.jge("_abs_e1"); vm.add(VReg.S2, VReg.S2, VReg.S3); vm.label("_abs_e1");
        vm.cmpImm(VReg.S2, 0); vm.jge("_abs_e2"); vm.movImm(VReg.S2, 0); vm.label("_abs_e2");
        vm.cmp(VReg.S2, VReg.S3); vm.jle("_abs_e3"); vm.mov(VReg.S2, VReg.S3); vm.label("_abs_e3");

        // 新长度 = end - start(end<start → 0,不为负)
        vm.sub(VReg.S3, VReg.S2, VReg.S1);
        vm.cmpImm(VReg.S3, 0); vm.jge("_abs_l0"); vm.movImm(VReg.S3, 0); vm.label("_abs_l0");

        vm.mov(VReg.A0, VReg.S3);
        vm.call("_arraybuffer_new");
        vm.mov(VReg.S4, VReg.RET);      // 新 buffer
        vm.load(VReg.V1, VReg.S4, 16);  // 目标 data_ptr

        // 逐字节复制:dst[i] = src[start + i]
        vm.movImm(VReg.V0, 0);
        vm.label("_arraybuffer_slice_loop");
        vm.cmp(VReg.V0, VReg.S3);
        vm.jge("_arraybuffer_slice_done");
        vm.add(VReg.V2, VReg.S1, VReg.V0); // start + i
        vm.add(VReg.V2, VReg.S0, VReg.V2); // src data_ptr + start + i
        vm.loadByte(VReg.V3, VReg.V2, 0);
        vm.add(VReg.V2, VReg.V1, VReg.V0); // dst data_ptr + i
        vm.storeByte(VReg.V2, 0, VReg.V3);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.jmp("_arraybuffer_slice_loop");

        vm.label("_arraybuffer_slice_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        vm.label("_abs_detached");
        vm.call("_ta_throw_detached"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
    }

    // ==================== DataView ====================
    // 布局(40B):[type=TYPE_DATA_VIEW(14)@0, data_ptr@8, byteOffset@16, byteLength@24, buffer@32]。
    // data_ptr 取自底层 buffer 的 data_ptr@16 → 与 buffer/源 TypedArray 共享同一内存。
    // buffer@32 是 GC 根,也是 IsDetachedBuffer(读 buffer.data_ptr@16==0)。

    // _dataview_new(buf, byteOffset, byteLength) -> DataView
    generateDataViewNew() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_dataview_new");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // byteOffset
        vm.mov(VReg.S2, VReg.A2); // byteLength
        // [guard] spec 25.3.2.1 步骤 2/3:第一实参不是 ArrayBuffer 就抛 TypeError。
        // 原实现直接 `load [buf&MASK+16]` 当 data_ptr:`new DataView({})` / `new DataView(5)` /
        // `new DataView(ta)` 读到垃圾地址,随后 get/set 越界写 → SIGSEGV。
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dvn_ptr");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_dvn_type");
        vm.label("_dvn_ptr");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.cmpImm(VReg.V0, 4095);
        vm.jle("_dvn_type");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jne("_dvn_type");
        vm.mov(VReg.S0, VReg.V0);       // 裸 buffer(GC 根,存 @32)
        // buf.data_ptr@16;已 detach → TypeError(规范 25.3.2.1)
        vm.load(VReg.S3, VReg.V0, 16);
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_dvn_detached");
        vm.movImm(VReg.A0, 40);
        vm.call("_alloc");
        vm.movImm(VReg.V1, TYPE_DATA_VIEW);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S3);  // data_ptr
        vm.store(VReg.RET, 16, VReg.S1); // byteOffset
        vm.store(VReg.RET, 24, VReg.S2); // byteLength
        vm.store(VReg.RET, 32, VReg.S0); // buffer
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_dvn_detached");
        vm.call("_ta_throw_detached"); // 不返回
        vm.label("_dvn_type");
        vm.lea(VReg.A0, vm.asm.addString("First argument to DataView constructor must be an ArrayBuffer"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32); // 理论不达
    }

    // _dataview_get(dv, byteOffset, size, flags, le) -> canonical number。
    // flags: bit0=signed, bit1=float。字节按端序汇编(BE 升序 / LE 降序,均 acc=(acc<<8)|b,
    // 免变量移位);再按 size/flags 解释(有符号 sxt、float32 reinterpret、float64 直取位)。
    generateDataViewGet() {
        const vm = this.vm;
        vm.label("_dataview_get");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        // detached buffer → TypeError(先于越界 RangeError)
        vm.load(VReg.V5, VReg.A0, 32);       // buffer@32(V5 非本函数实参别名)
        vm.cmpImm(VReg.V5, 0);
        vm.jeq("_dvg_att");
        vm.movImm64(VReg.V6, 0x0000ffffffffffffn);
        vm.and(VReg.V5, VReg.V5, VReg.V6);
        vm.load(VReg.V6, VReg.V5, 16);
        vm.cmpImm(VReg.V6, 0);
        vm.jne("_dvg_att");
        vm.call("_ta_throw_detached");
        vm.label("_dvg_att");
        // [bounds] 0 <= byteOffset(A1) && byteOffset + size(A2) <= dv.byteLength@24;违则 RangeError
        vm.cmpImm(VReg.A1, 0);
        vm.jlt("_dvg_oob");
        vm.load(VReg.V0, VReg.A0, 24);       // dv.byteLength
        vm.add(VReg.V4, VReg.A1, VReg.A2);   // byteOffset + size(x64 V1≡A3=flags 下方才存,V4≡A5 非本函数实参)
        vm.cmp(VReg.V4, VReg.V0);
        vm.jgt("_dvg_oob");
        // base = dv.data_ptr@8 + dv.byteOffset@16 + byteOffset
        vm.load(VReg.V0, VReg.A0, 8);
        vm.load(VReg.V4, VReg.A0, 16);       // (同上:V1≡A3 会毁 flags)
        vm.add(VReg.V0, VReg.V0, VReg.V4);
        vm.add(VReg.S0, VReg.V0, VReg.A1); // S0 = base
        vm.mov(VReg.S1, VReg.A2);          // size
        vm.mov(VReg.S2, VReg.A3);          // flags
        vm.mov(VReg.S3, VReg.A4);          // le
        vm.movImm(VReg.S4, 0);             // acc
        vm.cmpImm(VReg.S3, 0);
        vm.jne("_dvg_le");
        // BE:i 0..size-1
        vm.movImm(VReg.S5, 0);
        vm.label("_dvg_be");
        vm.cmp(VReg.S5, VReg.S1);
        vm.jge("_dvg_asm");
        vm.add(VReg.V0, VReg.S0, VReg.S5);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.shlImm(VReg.S4, VReg.S4, 8);
        vm.or(VReg.S4, VReg.S4, VReg.V1);
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_dvg_be");
        // LE:i size-1..0
        vm.label("_dvg_le");
        vm.subImm(VReg.S5, VReg.S1, 1);
        vm.label("_dvg_le_loop");
        vm.cmpImm(VReg.S5, 0);
        vm.jlt("_dvg_asm");
        vm.add(VReg.V0, VReg.S0, VReg.S5);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.shlImm(VReg.S4, VReg.S4, 8);
        vm.or(VReg.S4, VReg.S4, VReg.V1);
        vm.subImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_dvg_le_loop");
        vm.label("_dvg_asm");
        // S4 = 零扩展的 size 字节值。解释:
        vm.andImm(VReg.V0, VReg.S2, 2);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_dvg_float");
        // 整数:有符号则 sxt
        vm.andImm(VReg.V0, VReg.S2, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_dvg_int_done");
        vm.cmpImm(VReg.S1, 1);
        vm.jne("_dvg_sxt2");
        vm.shlImm(VReg.S4, VReg.S4, 56); vm.sarImm(VReg.S4, VReg.S4, 56); vm.jmp("_dvg_int_done");
        vm.label("_dvg_sxt2");
        vm.cmpImm(VReg.S1, 2);
        vm.jne("_dvg_sxt4");
        vm.shlImm(VReg.S4, VReg.S4, 48); vm.sarImm(VReg.S4, VReg.S4, 48); vm.jmp("_dvg_int_done");
        vm.label("_dvg_sxt4");
        vm.cmpImm(VReg.S1, 4);
        vm.jne("_dvg_int_done"); // size 8:无需扩展
        vm.shlImm(VReg.S4, VReg.S4, 32); vm.sarImm(VReg.S4, VReg.S4, 32);
        vm.label("_dvg_int_done");
        vm.scvtf(0, VReg.S4);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        // float:size 8 → 位即 canonical 数;size 4 → f32 reinterpret → f64
        vm.label("_dvg_float");
        vm.cmpImm(VReg.S1, 8);
        vm.jne("_dvg_f32");
        vm.mov(VReg.RET, VReg.S4); // f64 位模式即 canonical number
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_dvg_f32");
        vm.fmovToFloatSingle(0, VReg.S4);
        vm.fcvts2d(0, 0);
        vm.fmovToInt(VReg.A0, 0);
        // f32 qNaN → f64 0x7ff8… 与 int0 别名,归一
        vm.call("_nan_canon");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_dvg_oob");
        vm.call("_ta_throw_range"); // RangeError,不返回
    }

    // _dataview_set(dv, byteOffset, value, size, flags, le)。value 为 canonical 数(f64 位)。
    // float 按 size 转 f32/f64 位;整数 fcvtzs 截断。再按端序拆字节写(BE 高位在低地址)。
    generateDataViewSet() {
        const vm = this.vm;
        vm.label("_dataview_set");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        // 实参先落 S 系:x64 上 V1≡A3/V3≡A4/V4≡A5,下方边界检查的 V1 暂存会把
        // A3(size) 毁掉(F2:非窗口 dv 写静默 no-op 根因);先存再用即免疫。
        vm.mov(VReg.S1, VReg.A2);          // value(f64 位)
        vm.mov(VReg.S2, VReg.A3);          // size
        vm.mov(VReg.S3, VReg.A4);          // flags
        vm.mov(VReg.S4, VReg.A5);          // le
        // detached buffer → TypeError(先于越界 RangeError)
        vm.load(VReg.V5, VReg.A0, 32);
        vm.cmpImm(VReg.V5, 0);
        vm.jeq("_dvs_att");
        vm.movImm64(VReg.V6, 0x0000ffffffffffffn);
        vm.and(VReg.V5, VReg.V5, VReg.V6);
        vm.load(VReg.V6, VReg.V5, 16);
        vm.cmpImm(VReg.V6, 0);
        vm.jne("_dvs_att");
        vm.call("_ta_throw_detached");
        vm.label("_dvs_att");
        // [bounds] 0 <= byteOffset(A1) && byteOffset + size(A3) <= dv.byteLength@24;违则 RangeError
        vm.cmpImm(VReg.A1, 0);
        vm.jlt("_dvs_oob");
        vm.load(VReg.V0, VReg.A0, 24);       // dv.byteLength
        vm.add(VReg.V1, VReg.A1, VReg.A3);   // byteOffset + size
        vm.cmp(VReg.V1, VReg.V0);
        vm.jgt("_dvs_oob");
        vm.load(VReg.V0, VReg.A0, 8);
        vm.load(VReg.V1, VReg.A0, 16);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.add(VReg.S0, VReg.V0, VReg.A1); // base
        // 计算写入位模式 → S5(size 字节,右对齐)
        vm.andImm(VReg.V0, VReg.S3, 2);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_dvs_float");
        // 整数:fcvtzs(value 的 f64 → 有符号整数,截断)
        vm.fmovToFloat(0, VReg.S1);
        vm.fcvtzs(VReg.S5, 0);
        vm.jmp("_dvs_write");
        vm.label("_dvs_float");
        vm.cmpImm(VReg.S2, 8);
        vm.jne("_dvs_f32");
        vm.mov(VReg.S5, VReg.S1); // f64 位直写
        vm.jmp("_dvs_write");
        vm.label("_dvs_f32");
        vm.fmovToFloat(0, VReg.S1);   // d0 = value
        vm.fcvtd2s(0, 0);      // s0 = (f32)value
        vm.fmovToIntSingle(VReg.S5, 0); // S5 = f32 位(低 32)
        vm.label("_dvs_write");
        // 按端序写 size 字节:LE 低地址=LSB;BE 低地址=MSB。
        // 统一:从最高有效字节到最低,BE 写 base+0..、LE 写 base+size-1..;均 val>>=8。
        // 用降序索引 i=size-1..0,取 val 低字节,写到 (le? base+i : base+(size-1-i)),val>>=8。
        vm.subImm(VReg.S1, VReg.S2, 1); // i = size-1(复用 S1)
        vm.label("_dvs_loop");
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_dvs_done");
        vm.andImm(VReg.V1, VReg.S5, 0xff); // 低字节(第 size-1-i 个,从 LSB 起)
        // 循环序:i=size-1..0,每步取当前 val 的 LSB(即第 (size-1-i) 个字节)。
        // LE:第 j 字节 → base+j ⇒ addr = base+(size-1-i)。BE:第 j 字节 → base+(size-1-j)
        // ⇒ addr = base+i。
        vm.cmpImm(VReg.S4, 0);
        vm.jne("_dvs_le_addr");
        // BE:base + i
        vm.add(VReg.V0, VReg.S0, VReg.S1);
        vm.jmp("_dvs_store");
        vm.label("_dvs_le_addr");
        // LE:base + (size-1-i)
        vm.subImm(VReg.V0, VReg.S2, 1);
        vm.sub(VReg.V0, VReg.V0, VReg.S1);
        vm.add(VReg.V0, VReg.S0, VReg.V0);
        vm.label("_dvs_store");
        vm.storeByte(VReg.V0, 0, VReg.V1);
        vm.shrImm(VReg.S5, VReg.S5, 8);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_dvs_loop");
        vm.label("_dvs_done");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_dvs_oob");
        vm.call("_ta_throw_range"); // RangeError,不返回
    }

    // _ta_throw_range():构造 RangeError 普通对象 {name,message,__asmjs_err,cause}
    // (与 _throw_type_error 同表示,故 e instanceof RangeError / e.name === "RangeError" 成立),
    // 置异常槽后 _throw_unwind 交给最近 try/catch。不返回。
    // TypedArray/DataView 越界构造与 DataView 越界读写共用(Node 语义:抛 RangeError)。
    generateThrowRange() {
        const vm = this.vm;
        const boxStr = (reg) => { // reg 内 cstr 地址 → 堆串(0x7FFC)
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        vm.label("_ta_throw_range");
        vm.prologue(16, [VReg.S2]);
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET); // S2 = errObj(boxed)
        // name = "RangeError"
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("name")); boxStr(VReg.A1);
        vm.lea(VReg.A2, vm.asm.addString("RangeError")); boxStr(VReg.A2);
        vm.call("_object_set");
        // message
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("message")); boxStr(VReg.A1);
        vm.lea(VReg.A2, vm.asm.addString("Offset/length is outside the bounds")); boxStr(VReg.A2);
        vm.call("_object_set");
        // __asmjs_err = true(instanceof Error 族品牌)
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("__asmjs_err")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ff9000000000001n); // boxed true
        vm.call("_object_set");
        // cause = undefined
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
        vm.epilogue([VReg.S2], 16); // 理论不达
    }

    generate() {
        this.generateNew();
        this.generateNewMax();
        this.generateWrap();
        this.generateByteLength();
        this.generateMaxByteLength();
        this.generateMaxByteLengthProp();
        this.generateTrackTable();
        this.generateResize();
        this.generateDetach();
        this.generateDataPtr();
        this.generateSlice();
        this.generateDataViewNew();
        this.generateDataViewGet();
        this.generateDataViewSet();
        this.generateThrowRange();
    }
}

// ==================== TypedArray ====================

export class TypedArrayGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
        this.arch = vm.arch;
    }

    // 创建 TypedArray
    // _typed_array_new(type, length) -> TypedArray 指针
    // type 是 TYPE_INT8_ARRAY / TYPE_FLOAT64_ARRAY 等
    generateNew() {
        const vm = this.vm;

        vm.label("_typed_array_new");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // type (TYPE_*_ARRAY)
        vm.mov(VReg.S1, VReg.A1); // length

        // 根据 type 计算元素大小
        // 1字节: 0x40 (INT8), 0x50 (UINT8), 0x54 (UINT8_CLAMPED)
        // 2字节: 0x41 (INT16), 0x51 (UINT16)
        // 4字节: 0x42 (INT32), 0x52 (UINT32), 0x60 (FLOAT32)
        // 8字节: 0x43 (INT64), 0x53 (UINT64), 0x61 (FLOAT64)
        vm.movImm(VReg.S2, 8); // 默认大小 = 8

        // 检查 1 字节类型
        vm.cmpImm(VReg.S0, TYPE_INT8_ARRAY);
        vm.jeq("_ta_new_size_1");
        vm.cmpImm(VReg.S0, TYPE_UINT8_ARRAY);
        vm.jeq("_ta_new_size_1");
        vm.cmpImm(VReg.S0, TYPE_UINT8_CLAMPED_ARRAY);
        vm.jeq("_ta_new_size_1");
        vm.jmp("_ta_new_check_2");

        vm.label("_ta_new_size_1");
        vm.movImm(VReg.S2, 1);
        vm.jmp("_ta_new_size_done");

        // 检查 2 字节类型
        vm.label("_ta_new_check_2");
        vm.cmpImm(VReg.S0, TYPE_INT16_ARRAY);
        vm.jeq("_ta_new_size_2");
        vm.cmpImm(VReg.S0, TYPE_UINT16_ARRAY);
        vm.jeq("_ta_new_size_2");
        vm.jmp("_ta_new_check_4");

        vm.label("_ta_new_size_2");
        vm.movImm(VReg.S2, 2);
        vm.jmp("_ta_new_size_done");

        // 检查 4 字节类型
        vm.label("_ta_new_check_4");
        vm.cmpImm(VReg.S0, TYPE_INT32_ARRAY);
        vm.jeq("_ta_new_size_4");
        vm.cmpImm(VReg.S0, TYPE_UINT32_ARRAY);
        vm.jeq("_ta_new_size_4");
        vm.cmpImm(VReg.S0, TYPE_FLOAT32_ARRAY);
        vm.jeq("_ta_new_size_4");
        vm.jmp("_ta_new_size_done"); // 默认 8 字节

        vm.label("_ta_new_size_4");
        vm.movImm(VReg.S2, 4);

        vm.label("_ta_new_size_done");

        // [guard] 拒绝负长度 / 溢出长度(如误把 tagged 指针当长度 → ~1e10)。防 mul 溢出与巨额 alloc。
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_ta_new_badlen");
        vm.movImm64(VReg.V0, 0x7fffffffn); // 上限 2^31-1 元素(足够;挡越界)
        vm.cmp(VReg.S1, VReg.V0);
        vm.jgt("_ta_new_badlen");

        // [Design A] 32B 头 + 内联数据:[type@0, length@8, data_ptr@16, buffer@24, data@32]。
        // 元素访问统一经 data_ptr(内联=self+32;buffer 视图=buffer.data_ptr+byteOffset),
        // buffer@24=底层 ArrayBuffer(视图用,GC 根;内联=0,首次 .buffer 惰性建 wrapper 缓存)。
        vm.mul(VReg.V0, VReg.S1, VReg.S2);
        vm.addImm(VReg.A0, VReg.V0, 32);
        vm.call("_alloc");
        vm.mov(VReg.V1, VReg.RET); // 保存指针

        vm.store(VReg.V1, 0, VReg.S0);  // type
        vm.store(VReg.V1, 8, VReg.S1);  // length
        vm.addImm(VReg.V0, VReg.V1, 32);
        vm.store(VReg.V1, 16, VReg.V0); // data_ptr = self + 32(内联)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V1, 24, VReg.V0); // buffer = 0(内联)

        vm.mov(VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_ta_new_badlen");
        vm.call("_ta_throw_range"); // RangeError: Invalid typed array length,不返回
    }

    // [Design A] _typed_array_view(type, buffer, byteOffset, length) -> TypedArray 视图。
    // data_ptr = buffer.data_ptr@16 + byteOffset;buffer@24 = 底层 buffer(GC 根)。共享其字节。
    generateView() {
        const vm = this.vm;
        vm.label("_typed_array_view");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // type
        vm.mov(VReg.S1, VReg.A1); // buffer(boxed/裸)
        vm.mov(VReg.S2, VReg.A2); // byteOffset
        vm.mov(VReg.S3, VReg.A3); // length(元素数)

        // [bounds] 验 byteOffset>=0、对齐、length>=0、byteOffset+length*elemSize<=buffer.byteLength。
        // elemSize 由 type 求(V4);无函数调用,V 寄存器稳定。违则 RangeError。
        vm.movImm(VReg.V4, 8); // 默认 8
        vm.cmpImm(VReg.S0, TYPE_INT8_ARRAY); vm.jeq("_tav_e1");
        vm.cmpImm(VReg.S0, TYPE_UINT8_ARRAY); vm.jeq("_tav_e1");
        vm.cmpImm(VReg.S0, TYPE_UINT8_CLAMPED_ARRAY); vm.jeq("_tav_e1");
        vm.cmpImm(VReg.S0, TYPE_INT16_ARRAY); vm.jeq("_tav_e2");
        vm.cmpImm(VReg.S0, TYPE_UINT16_ARRAY); vm.jeq("_tav_e2");
        vm.cmpImm(VReg.S0, TYPE_INT32_ARRAY); vm.jeq("_tav_e4");
        vm.cmpImm(VReg.S0, TYPE_UINT32_ARRAY); vm.jeq("_tav_e4");
        vm.cmpImm(VReg.S0, TYPE_FLOAT32_ARRAY); vm.jeq("_tav_e4");
        vm.jmp("_tav_edone");
        vm.label("_tav_e1"); vm.movImm(VReg.V4, 1); vm.jmp("_tav_edone");
        vm.label("_tav_e2"); vm.movImm(VReg.V4, 2); vm.jmp("_tav_edone");
        vm.label("_tav_e4"); vm.movImm(VReg.V4, 4);
        vm.label("_tav_edone");
        vm.cmpImm(VReg.S2, 0); vm.jlt("_tav_oob"); // byteOffset < 0
        vm.cmpImm(VReg.S3, 0); vm.jlt("_tav_oob"); // length < 0
        vm.subImm(VReg.V0, VReg.V4, 1);            // elemSize-1(elemSize 为 2 的幂)
        vm.and(VReg.V0, VReg.S2, VReg.V0);         // byteOffset & (elemSize-1)
        vm.cmpImm(VReg.V0, 0); vm.jne("_tav_oob"); // 未对齐
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1);         // 裸 buffer
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jne("_tav_detached");                   // 非 AB(误传入 TA)→ TypeError,先于越界 RangeError
        vm.load(VReg.V3, VReg.V0, 16);             // data_ptr;0 = detached → TypeError
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_tav_detached");
        vm.load(VReg.V3, VReg.V0, 8);              // buffer.byteLength
        vm.mul(VReg.V0, VReg.S3, VReg.V4);         // length*elemSize
        vm.add(VReg.V0, VReg.V0, VReg.S2);         // + byteOffset
        vm.cmp(VReg.V0, VReg.V3); vm.jgt("_tav_oob");

        vm.movImm(VReg.A0, 40);   // 40B 头:byteOffset@32(detach 后仍可读 [[ByteOffset]])
        vm.call("_alloc");
        vm.store(VReg.RET, 0, VReg.S0);   // type
        vm.store(VReg.RET, 8, VReg.S3);   // length
        // data_ptr = buffer.data_ptr@16 + byteOffset
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V2, VReg.S1, VReg.V1); // 裸 buffer 指针
        vm.load(VReg.V2, VReg.V2, 16);     // buffer.data_ptr
        vm.add(VReg.V2, VReg.V2, VReg.S2); // + byteOffset
        vm.store(VReg.RET, 16, VReg.V2);   // data_ptr
        vm.store(VReg.RET, 24, VReg.S1);   // buffer(GC 根)
        vm.store(VReg.RET, 32, VReg.S2);   // [[ByteOffset]] 内槽(getter 仍可对 detached 返 0)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
        vm.label("_tav_oob");
        vm.call("_ta_throw_range"); // RangeError,不返回
        vm.label("_tav_detached");
        vm.call("_ta_throw_detached"); // TypeError,不返回
    }

    // 获取 TypedArray 元素
    // _typed_array_get(arr, index) -> value (raw)
    // 根据 type 字段确定元素大小
    generateGet() {
        const vm = this.vm;

        vm.label("_typed_array_get");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // index

        // detached → 与 OOB 同:读 undefined(IntegerIndexedElementGet)
        vm.call("_ta_is_detached"); // A0 仍是 arr
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ta_get_oob");
        // 固定长度视图 resize 后整视图越界 → undefined(勿信陈旧 length@8)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ta_get_oob");

        // [bounds] 越界读返回 undefined(spec:OOB TypedArray 元素读 → undefined,不抛)。
        vm.load(VReg.V0, VReg.S0, 8); // length
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_ta_get_oob");
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_ta_get_oob");

        // 加载 type 字段
        vm.load(VReg.S2, VReg.S0, 0);
        vm.andImm(VReg.S2, VReg.S2, 0xff); // S2 = 元素类型
        // [Design A] 元素基址改用 data_ptr(内联/视图统一)。既有寻址用 base+TYPED_ARRAY_HEADER
        // (+16),故置 S0 = data_ptr - 16,令后续 base+16 恰读 data_ptr。
        vm.load(VReg.S0, VReg.S0, 16);
        vm.subImm(VReg.S0, VReg.S0, 16);

        // 按元素大小分派（原实现固定按 8 字节读 index*8，Uint8Array 等全错——
        // 是自举 floatToInt64Bits 读字节全 0 → 数字全编成 0 的根因之一）。
        // 结果统一转成 canonical float64（NaN-boxing 数字表示）返回。
        vm.cmpImm(VReg.S2, TYPE_INT8_ARRAY);
        vm.jeq("_ta_get_byte");
        vm.cmpImm(VReg.S2, TYPE_UINT8_ARRAY);
        vm.jeq("_ta_get_byte");
        vm.cmpImm(VReg.S2, TYPE_UINT8_CLAMPED_ARRAY);
        vm.jeq("_ta_get_byte");
        vm.cmpImm(VReg.S2, TYPE_INT16_ARRAY);
        vm.jeq("_ta_get_half");
        vm.cmpImm(VReg.S2, TYPE_UINT16_ARRAY);
        vm.jeq("_ta_get_half");
        vm.cmpImm(VReg.S2, TYPE_INT32_ARRAY);
        vm.jeq("_ta_get_word");
        vm.cmpImm(VReg.S2, TYPE_UINT32_ARRAY);
        vm.jeq("_ta_get_word");
        vm.cmpImm(VReg.S2, TYPE_FLOAT32_ARRAY);
        vm.jeq("_ta_get_f32");
        vm.cmpImm(VReg.S2, TYPE_INT64_ARRAY);
        vm.jeq("_ta_get_bigint");
        vm.cmpImm(VReg.S2, TYPE_UINT64_ARRAY);
        vm.jeq("_ta_get_bigint");

        // 默认 8 字节 Float64：位模式即 canonical float64，直接返回
        vm.shl(VReg.V1, VReg.S1, 3);
        vm.addImm(VReg.V1, VReg.V1, TYPED_ARRAY_HEADER);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.load(VReg.RET, VReg.V1, 0);
        vm.jmp("_ta_get_done");

        // BigInt64/BigUint64:裸 int64 → _bigint_box
        vm.label("_ta_get_bigint");
        vm.shl(VReg.V1, VReg.S1, 3);
        vm.addImm(VReg.V1, VReg.V1, TYPED_ARRAY_HEADER);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.load(VReg.A0, VReg.V1, 0);
        vm.call("_bigint_box");
        vm.jmp("_ta_get_done");

        // 1 字节读取
        vm.label("_ta_get_byte");
        vm.add(VReg.V1, VReg.S0, VReg.S1);                  // arr + index (elem=1)
        vm.loadByte(VReg.RET, VReg.V1, TYPED_ARRAY_HEADER); // 零扩展字节
        vm.cmpImm(VReg.S2, TYPE_INT8_ARRAY);
        vm.jne("_ta_get_int_to_f64");
        vm.shl(VReg.RET, VReg.RET, 56);                     // Int8 符号扩展
        vm.sar(VReg.RET, VReg.RET, 56);
        vm.jmp("_ta_get_int_to_f64");

        // 2 字节读取 (LE)
        vm.label("_ta_get_half");
        vm.shl(VReg.V1, VReg.S1, 1);                        // index*2
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.RET, VReg.V1, TYPED_ARRAY_HEADER);
        vm.loadByte(VReg.V2, VReg.V1, TYPED_ARRAY_HEADER + 1); // (x64 V2==A2 无活值;V0≡RET 会盖掉低字节累加器)
        vm.shl(VReg.V2, VReg.V2, 8);
        vm.or(VReg.RET, VReg.RET, VReg.V2);
        vm.cmpImm(VReg.S2, TYPE_INT16_ARRAY);
        vm.jne("_ta_get_int_to_f64");
        vm.shl(VReg.RET, VReg.RET, 48);                     // Int16 符号扩展
        vm.sar(VReg.RET, VReg.RET, 48);
        vm.jmp("_ta_get_int_to_f64");

        // 4 字节读取 (LE)
        vm.label("_ta_get_word");
        vm.shl(VReg.V1, VReg.S1, 2);                        // index*4
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.load32(VReg.RET, VReg.V1, TYPED_ARRAY_HEADER);
        vm.cmpImm(VReg.S2, TYPE_INT32_ARRAY);
        vm.jne("_ta_get_int_to_f64");
        vm.shl(VReg.RET, VReg.RET, 32);                     // Int32 符号扩展
        vm.sar(VReg.RET, VReg.RET, 32);
        // fall through

        // 整数 -> canonical float64。TypedArray 无 hole,返回裸 float +0(0x0)即可;
        // 与数组 int0 的跨表示相等由 _strict_eq / Object.is 处理(勿在此返 int0:
        // 多参 console.log 非末位会把 int0 当 IEEE NaN 打印)。
        vm.label("_ta_get_int_to_f64");
        vm.scvtf(0, VReg.RET);       // d0 = (double) RET
        vm.fmovToInt(VReg.RET, 0);   // RET = float64 位模式
        vm.jmp("_ta_get_done");

        // Float32 -> float64
        vm.label("_ta_get_f32");
        vm.shl(VReg.V1, VReg.S1, 2);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.RET, VReg.V1, TYPED_ARRAY_HEADER);
        vm.loadByte(VReg.V2, VReg.V1, TYPED_ARRAY_HEADER + 1); // (x64 V2==A2 无活值;V0≡RET 会盖掉位组装累加器)
        vm.shl(VReg.V2, VReg.V2, 8); vm.or(VReg.RET, VReg.RET, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V1, TYPED_ARRAY_HEADER + 2);
        vm.shl(VReg.V2, VReg.V2, 16); vm.or(VReg.RET, VReg.RET, VReg.V2);
        vm.loadByte(VReg.V2, VReg.V1, TYPED_ARRAY_HEADER + 3);
        vm.shl(VReg.V2, VReg.V2, 24); vm.or(VReg.RET, VReg.RET, VReg.V2);
        vm.fmovToFloatSingle(0, VReg.RET); // 位模式 -> s0 单精度
        vm.fcvts2d(0, 0);                  // f32 -> f64
        vm.fmovToInt(VReg.RET, 0);
        // f32 qNaN(0x7fc00000) 升 f64 得 0x7ff8…——与装箱 int0 位别名;
        // 必须 _nan_canon,否则读回当 0、isNaN/SameValue(NaN) 全错。
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_nan_canon");
        vm.jmp("_ta_get_done");

        vm.label("_ta_get_oob");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // undefined
        // fall through
        vm.label("_ta_get_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // 设置 TypedArray 元素
    // _typed_array_set(arr, index, value)
    // value 可以是 boxed Number 指针或裸值
    // 如果是 boxed Number（在堆范围内且类型是 TYPE_FLOAT64 等），自动 unbox
    generateSet() {
        const vm = this.vm;

        vm.label("_typed_array_set");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // index
        vm.mov(VReg.S2, VReg.A2); // value (可能是 boxed Number 或 raw)
        vm.store(VReg.SP, 0, VReg.S0); // 原 TA(ToNumber 可 resize;写前再认活 bounds)

        // ES IntegerIndexedElementSet:先 ToNumber/ToBigInt,**再** IsValidIntegerIndex。
        // 不可在此早退 OOB —— valueOf 里 resize 伸长后原越界下标须能写
        // (built-ins/TypedArray/of/resized-with-out-of-bounds-and-in-bounds-indices)。

        // 加载数组类型
        vm.load(VReg.S4, VReg.S0, 0);
        vm.andImm(VReg.S4, VReg.S4, 0xff);

        // BigInt64/BigUint64:值若为 BigInt,取 [ptr+0] 裸 int64 位再存(禁把堆指针当 raw)
        vm.cmpImm(VReg.S4, TYPE_INT64_ARRAY);
        vm.jeq("_ta_set_maybe_bi");
        vm.cmpImm(VReg.S4, TYPE_UINT64_ARRAY);
        vm.jne("_ta_set_not_bi_ta");
        vm.label("_ta_set_maybe_bi");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ta_set_not_bi_ta");
        vm.load(VReg.S2, VReg.S2, 0); // BigInt 载荷
        vm.load(VReg.V0, VReg.S0, 16);
        vm.subImm(VReg.S0, VReg.V0, 16);
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_not_bi_ta");

        // [Design A] 元素基址改用 data_ptr:S0 = data_ptr - 16(既有 store 用 base+16)。
        vm.load(VReg.V0, VReg.S0, 16);
        vm.subImm(VReg.S0, VReg.V0, 16);

        // 裸 canonical float64 值（如数字字面量 65 = 0x4050400000000000）：
        // high16 非零且 < 0x7ff8 即是规范浮点数（堆指针 high16 恒为 0）。
        // 此前只对堆 Number 对象 unbox，裸 float64 被上界检查误当 raw → 存低字节 0x00，
        // 是 Uint8Array 存数字全变 0 的根因（连累自举 floatToInt64Bits 返回 0，数字全编成 0）。
        vm.shr(VReg.V1, VReg.S2, 48); // high16
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_ta_set_check_heap"); // high16==0：小整数/堆指针/0.0，走原堆检查
        // 规范浮点判据:(high16 & 0x7ff8) != 0x7ff8 排除所有 NaN-box tag(0x7ff8-0x7fff
        // 及负数镜像 0xfff8-0xffff)。原 `high16 < 0x7ff8` 只捕获正浮点,负浮点(high16
        // >=0x8000,如 -5.0=0xC014…)漏判 → 落 check_heap 当 raw → 存低字节 0 → 负数
        // 存 Int8/Int16 全变 0(既有 bug)。
        vm.andImm(VReg.V2, VReg.V1, 0x7ff8);
        vm.cmpImm(VReg.V2, 0x7ff8);
        vm.jne("_ta_set_have_bits"); // 非 NaN-tag → S2 是规范浮点位模式(含负数)
        // [W-32] 正向 NaN-box tag 0x7FF8..0x7FFF = **装箱的非 double 值**
        // (0x7FF8 int32 / 0x7FF9 bool / 0x7FFA null / 0x7FFB undefined / 0x7FFC string /
        //  0x7FFD object / 0x7FFE array / 0x7FFF function)。ES 要求元素写先 ToNumber;
        // 此前把位模式**原样存下**:Float64Array 存进 0x7FFB…(读回竟 `=== undefined`)、
        // 存进串/对象指针;整型数组则存指针低 32 位(实测 f64[i]="3.5" → 3.5 变
        // 70777452)。真 NaN 在本运行时是 0x7FF0000000000001(high16=0x7FF0),不在此
        // 区间;负向 0xFFF8..0xFFFF 是 IEEE -NaN(fneg 硬件 qNaN),须当 float 存,
        // 不可落 check_heap 把低 32 位 0 写入 Float32 → 读回 0.0。
        vm.cmpImm(VReg.V1, 0x7FF8);
        vm.jeq("_ta_set_boxed_int"); // 装箱 int32:载荷已是 ToInt32/ToUint32 位
        vm.jlt("_ta_set_check_heap");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jgt("_ta_set_have_bits");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_number_coerce");   // ToNumber:undefined→NaN、null→+0、bool→0/1、
        vm.mov(VReg.S2, VReg.RET);   // 串→_str_to_num、对象→NaN
        vm.jmp("_ta_set_have_bits");

        // 0x7FF8 旧路走完整 _number_coerce(_is_bigint/_is_symbol/符号扩展/scvtf)
        // 再 fcvtzs 回整数——`>>> 0` 热写的主税。整数目标直接落载荷;
        // 浮点目标按有符号 int32 转 float,与 _num_coerce_int32 一致。
        vm.label("_ta_set_boxed_int");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S2, VReg.S2, VReg.V1);
        vm.movImm64(VReg.V1, 0xFFFFFFFFn);
        vm.and(VReg.S2, VReg.S2, VReg.V1);
        vm.cmpImm(VReg.S4, TYPE_FLOAT64_ARRAY);
        vm.jeq("_ta_set_boxed_int_f64");
        vm.cmpImm(VReg.S4, TYPE_FLOAT32_ARRAY);
        vm.jeq("_ta_set_boxed_int_f32");
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_boxed_int_f64");
        vm.shlImm(VReg.S2, VReg.S2, 32);
        vm.sarImm(VReg.S2, VReg.S2, 32);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.S2, 0);
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_boxed_int_f32");
        vm.shlImm(VReg.S2, VReg.S2, 32);
        vm.sarImm(VReg.S2, VReg.S2, 32);
        vm.scvtf(0, VReg.S2);
        vm.fcvtd2s(0, 0);
        vm.fmovToIntSingle(VReg.S2, 0);
        vm.jmp("_ta_set_raw");

        vm.label("_ta_set_check_heap");
        // 检查 value 是否是 boxed Number（需要 unbox）
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.S3, VReg.V0, 0); // S3 = heap_base

        vm.cmp(VReg.S2, VReg.S3);
        vm.jlt("_ta_set_raw"); // 小于 heap_base，当作 raw

        // [W-32/K1] Symbol → TypeError(ES: ToNumber(symbol) 抛;此前静默存指针低字节)。
        // Symbol 是**裸堆指针 + 用户区标记块**([ptr]==TYPE_SYMBOL(61)),故判据放在
        // heap_base 之后。**必须早于**下方那段硬编码上界(0x100200000)检查:native 上
        // heap_base 实测高于该常量,那条 jge 恒成立 → 放后面则分支永不可达。
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_ta_set_notsym");
        vm.load(VReg.V0, VReg.S2, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 61); // TYPE_SYMBOL
        vm.jeq("_ta_set_symbol");
        vm.label("_ta_set_notsym");

        // 额外检查：上界之外不是堆对象
        if (vm.platform === "wasi") {
            // wasi:上界用真实堆 bump 指针 _heap_ptr。若沿用硬编码常量,wasi 堆基址
            // (0x8000000)与"上界"重合 → unbox 窗口恒空。
            // (native 侧观察:该窗口 [heap_base, 0x100200000) 因 heap_base 实测高于
            // 常量而疑似恒空,boxed-Number unbox 分支等效死代码——被上方规范浮点快路
            // 掩蔽未显症。不动 native 发射语义,仅在 WASM_DESIGN.md 记录待产品侧核。)
            vm.lea(VReg.V0, "_heap_ptr");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.S2, VReg.V0);
            vm.jge("_ta_set_raw"); // >= heap_ptr:不在已分配堆内,当作 raw
        } else {
            vm.movImm(VReg.V0, 0x100200000);
            vm.cmp(VReg.S2, VReg.V0);
            vm.jge("_ta_set_raw"); // >= 0x100200000，当作 raw
        }

        // 检查类型是否是 Number
        vm.load(VReg.V0, VReg.S2, 0);
        vm.andImm(VReg.V0, VReg.V0, 0xff);

        // TYPE_NUMBER (13) 和 TYPE_FLOAT64 (29): offset 8 都是 float64 位模式
        vm.cmpImm(VReg.V0, 13); // TYPE_NUMBER
        vm.jeq("_ta_set_unbox");
        vm.cmpImm(VReg.V0, 29); // TYPE_FLOAT64
        vm.jne("_ta_set_raw"); // 其他类型当作 raw

        // unbox 路径：从 Number 对象中取出 float64 位模式
        vm.label("_ta_set_unbox");
        vm.load(VReg.S2, VReg.S2, 8); // S2 = float64 位模式

        vm.label("_ta_set_have_bits");
        // S2 = float64 位模式（来自堆 Number unbox 或裸 canonical float64）
        // 如果目标是浮点类型，保持位模式
        vm.cmpImm(VReg.S4, TYPE_FLOAT64_ARRAY);
        vm.jeq("_ta_set_raw");
        vm.cmpImm(VReg.S4, TYPE_FLOAT32_ARRAY);
        vm.jeq("_ta_set_convert_f32");

        // 整数类型:ToInt32/ToUintN 要求 NaN/±Inf → +0。裸 fcvtzs(+Inf) 饱和到
        // INT64_MAX,低 32/16/8 位变成 -1/0xFFFF/0xFF(既有 bug)。
        // Uint8Clamped 例外:ToUint8Clamp(+Inf)=255,NaN/-Inf=0。
        vm.cmpImm(VReg.S4, TYPE_UINT8_CLAMPED_ARRAY);
        vm.jeq("_ta_set_clamp_from_f64");
        vm.shrImm(VReg.V1, VReg.S2, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jeq("_ta_set_int_naninf");
        vm.fmovToFloat(0, VReg.S2);
        vm.fcvtzs(VReg.S2, 0);
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_int_naninf");
        vm.movImm(VReg.S2, 0);
        vm.jmp("_ta_set_raw");

        // ToUint8Clamp(f64 bits in S2)
        vm.label("_ta_set_clamp_from_f64");
        vm.shrImm(VReg.V1, VReg.S2, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jne("_ta_set_clamp_finite");
        // NaN / ±Inf:mantissa≠0 → NaN→0;sign→-Inf→0;else +Inf→255
        vm.movImm64(VReg.V0, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.S2, VReg.V0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_set_clamp_zero"); // NaN
        vm.cmpImm(VReg.S2, 0);
        vm.jlt("_ta_set_clamp_zero"); // -Inf
        vm.movImm(VReg.S2, 255); // +Inf
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_clamp_zero");
        vm.movImm(VReg.S2, 0);
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_clamp_finite");
        // ES ToUint8Clamp:≤0→0;≥255→255;否则 floor+半入偶(ties to even)
        vm.fmovToFloat(0, VReg.S2);                 // d0 = x
        vm.movImm(VReg.V0, 0);
        vm.fmovToFloat(1, VReg.V0);                 // d1 = 0
        vm.fcmp(0, 1);
        vm.jfle("_ta_set_clamp_zero");             // x ≤ 0 → 0
        vm.movImm64(VReg.V0, 0x406fe00000000000n); // 255.0
        vm.fmovToFloat(1, VReg.V0);
        vm.fcmp(0, 1);
        vm.jfge("_ta_set_clamp_hi255");            // x ≥ 255 → 255
        vm.ffloor(2, 0);                           // d2 = f = floor(x)
        vm.movImm64(VReg.V0, 0x3fe0000000000000n); // 0.5
        vm.fmovToFloat(1, VReg.V0);
        vm.fadd(3, 2, 1);                          // d3 = f + 0.5
        vm.fcmp(0, 3);
        vm.jfgt("_ta_set_clamp_ceil");             // x > f+0.5 → f+1
        vm.jflt("_ta_set_clamp_floor");            // x < f+0.5 → f
        // tie: f odd → f+1, else f
        vm.fcvtzs(VReg.S2, 2);
        vm.andImm(VReg.V0, VReg.S2, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ta_set_raw");                     // even
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_clamp_ceil");
        vm.fcvtzs(VReg.S2, 2);
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_clamp_floor");
        vm.fcvtzs(VReg.S2, 2);
        vm.jmp("_ta_set_raw");
        vm.label("_ta_set_clamp_hi255");
        vm.movImm(VReg.S2, 255);
        vm.jmp("_ta_set_raw");

        // Float32Array: 将 float64 转换为 float32 位模式
        vm.label("_ta_set_convert_f32");
        vm.fmovToFloat(0, VReg.S2);
        vm.fcvtd2s(0, 0); // double to single
        vm.fmovToIntSingle(VReg.S2, 0);

        vm.label("_ta_set_raw");
        // IntegerIndexedElementSet:ToNumber 之后若 detached → 不写(规范返 false,赋值忽略)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_ta_is_detached");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ta_set_done");
        // ToNumber 之后用**活** OOB/length(valueOf 可能已 resize)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ta_set_done");
        vm.load(VReg.V1, VReg.SP, 0);
        vm.load(VReg.V0, VReg.V1, 8); // 活 length
        vm.cmpImm(VReg.S1, 0);
        vm.jlt("_ta_set_done");
        vm.cmp(VReg.S1, VReg.V0);
        vm.jge("_ta_set_done");
        // 刷新 data_ptr 基址(resize 后仍有效;与 coerce 前设置对齐)
        vm.load(VReg.V0, VReg.V1, 16);
        vm.subImm(VReg.S0, VReg.V0, 16);
        // S2 = raw value (整数或位模式), S4 = array type

        // Int8Array (0x40), Uint8Array (0x50), Uint8ClampedArray (0x54)
        vm.cmpImm(VReg.S4, TYPE_INT8_ARRAY);
        vm.jeq("_ta_set_byte");
        vm.cmpImm(VReg.S4, TYPE_UINT8_ARRAY);
        vm.jeq("_ta_set_byte");
        vm.cmpImm(VReg.S4, TYPE_UINT8_CLAMPED_ARRAY);
        vm.jeq("_ta_set_byte_clamped");

        // Int16Array (0x41), Uint16Array (0x51)
        vm.cmpImm(VReg.S4, TYPE_INT16_ARRAY);
        vm.jeq("_ta_set_half");
        vm.cmpImm(VReg.S4, TYPE_UINT16_ARRAY);
        vm.jeq("_ta_set_half");

        // Int32Array (0x42), Uint32Array (0x52), Float32Array (0x60)
        vm.cmpImm(VReg.S4, TYPE_INT32_ARRAY);
        vm.jeq("_ta_set_word");
        vm.cmpImm(VReg.S4, TYPE_UINT32_ARRAY);
        vm.jeq("_ta_set_word");
        vm.cmpImm(VReg.S4, TYPE_FLOAT32_ARRAY);
        vm.jeq("_ta_set_word");

        // 默认 8 字节 (Int64Array, Uint64Array, Float64Array)
        vm.shl(VReg.V0, VReg.S1, 3);
        vm.addImm(VReg.V0, VReg.V0, TYPED_ARRAY_HEADER);
        vm.add(VReg.V0, VReg.S0, VReg.V0);
        vm.store(VReg.V0, 0, VReg.S2);
        vm.jmp("_ta_set_done");

        // Uint8ClampedArray:值钳制到 [0,255](node 语义:越界不环绕而饱和),再落字节。
        // S2 为已转整数的有符号值,用有符号比较分派。
        vm.label("_ta_set_byte_clamped");
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_ta_set_clamp_hi");
        vm.movImm(VReg.S2, 0);              // <0 → 0
        vm.jmp("_ta_set_byte");
        vm.label("_ta_set_clamp_hi");
        vm.cmpImm(VReg.S2, 255);
        vm.jle("_ta_set_byte");
        vm.movImm(VReg.S2, 255);            // >255 → 255
        // fallthrough → _ta_set_byte

        // 1 字节存储
        vm.label("_ta_set_byte");
        vm.add(VReg.V0, VReg.S0, VReg.S1); // arr + index
        vm.addImm(VReg.V0, VReg.V0, TYPED_ARRAY_HEADER);
        vm.storeByte(VReg.V0, 0, VReg.S2);
        vm.jmp("_ta_set_done");

        // 2 字节存储 (little-endian)
        vm.label("_ta_set_half");
        vm.shl(VReg.V0, VReg.S1, 1); // index * 2
        vm.add(VReg.V0, VReg.S0, VReg.V0);
        vm.addImm(VReg.V0, VReg.V0, TYPED_ARRAY_HEADER);
        vm.storeByte(VReg.V0, 0, VReg.S2); // 低字节
        vm.shr(VReg.V1, VReg.S2, 8);
        vm.storeByte(VReg.V0, 1, VReg.V1); // 高字节
        vm.jmp("_ta_set_done");

        // 4 字节存储 (little-endian)
        vm.label("_ta_set_word");
        vm.shl(VReg.V0, VReg.S1, 2); // index * 4
        vm.add(VReg.V0, VReg.S0, VReg.V0);
        vm.addImm(VReg.V0, VReg.V0, TYPED_ARRAY_HEADER);
        vm.store32(VReg.V0, 0, VReg.S2);
        // vm.jmp("_ta_set_done"); // fall through

        vm.label("_ta_set_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);

        // [W-32/K1] Symbol 元素写 → TypeError(不返回)。
        vm.label("_ta_set_symbol");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert a Symbol value to a number"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64); // 理论不达
    }

    // 获取 TypedArray 长度
    // _typed_array_length(arr) -> length
    generateLength() {
        const vm = this.vm;

        vm.label("_typed_array_length");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_ta_is_detached");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_talen_ok");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_talen_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_talen_live");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_talen_live");
        vm.load(VReg.RET, VReg.S0, 8);
        vm.epilogue([VReg.S0], 0);
    }

    // 生成所有 TypedArray 函数
    // _typed_array_from(A0=type, A1=srcArg boxed) -> TypedArray。srcArg 是数组(0x7FFE)→
    // 建同长 TypedArray 并逐元素拷贝(经 _subscript_get 取、_typed_array_set 按类型强转存);
    // 否则(数字)→ 当长度 _typed_array_new。修 `new Uint8Array(变量数组)` 把变量误当长度
    // 的 bug(compileTypedArrayNew 非字面量参数原一律 compileExpressionAsInt 当长度)。
    generateTypedArrayFrom() {
        const vm = this.vm;
        vm.label("_typed_array_from");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // type
        vm.mov(VReg.S1, VReg.A1); // srcArg(boxed)
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_taf_array");     // 普通数组 → 逐元素拷贝
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_taf_ptrck");     // boxed 对象:可能是 ArrayBuffer/TA 脱壳,先判头
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_taf_len");       // 数字等 → 当长度
        // 裸指针源:ArrayBuffer → 建视图(new TA(buf) 的动态形态,静态 inferType 判不出
        // 函数返回值的类型);TypedArray → 先转普通数组走拷贝路。此前一律落 _taf_len,
        // 把指针当长度 → RangeError/巨额分配。
        vm.label("_taf_ptrck");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.S5, VReg.S1, VReg.V1);
        vm.cmpImm(VReg.S5, 4095);
        vm.jle("_taf_notptr");
        vm.loadByte(VReg.V0, VReg.S5, 0);
        vm.cmpImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.jeq("_taf_buf");
        vm.cmpImm(VReg.V0, TYPE_INT8_ARRAY);
        vm.jlt("_taf_notptr");
        vm.cmpImm(VReg.V0, TYPE_FLOAT64_ARRAY);
        vm.jgt("_taf_notptr");
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_ta_to_array");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_taf_array");
        vm.label("_taf_buf");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_elem_size_of_type");
        vm.mov(VReg.S4, VReg.RET);          // elemSize
        vm.load(VReg.S3, VReg.S5, 8);       // buffer.byteLength
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_ta_track_div");           // 元素数
        vm.mov(VReg.A3, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S5);
        vm.movImm(VReg.A2, 0);
        vm.call("_typed_array_view");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S5);
        vm.movImm(VReg.A2, 0);
        vm.mov(VReg.A3, VReg.S4);
        vm.call("_ta_track_add");           // 缺省长度 → 跟踪视图
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_taf_notptr");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_taf_obj");       // boxed 对象/array-like → 读 .length 逐索引拷贝
        vm.jmp("_taf_len");       // 数字等 → 当长度
        // 数组:len = srcArr.length
        vm.label("_taf_array");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.S3, VReg.V0, 8); // len
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_typed_array_new");
        vm.mov(VReg.S2, VReg.RET); // ta
        vm.movImm(VReg.S4, 0); // i
        vm.label("_taf_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_taf_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_subscript_get"); // RET = srcArr[i]
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_typed_array_set");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_taf_loop");
        vm.label("_taf_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        // 数字:当长度
        vm.label("_taf_len");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_syscall_arg");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_new");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        // boxed 对象/array-like:len = ToInteger(obj.length),逐索引 obj[i] → ta[i]。
        // 此前落 _taf_len 把 tagged 指针当长度 → ~1e10 长度 → 段错/超时(~56 崩溃簇根因)。
        vm.label("_taf_obj");
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1); // boxed "length"
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");            // RET = obj.length(boxed;缺失/undefined → 归一为 0)
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_syscall_arg");           // RET = len(裸 int;_typed_array_new 再守卫负/溢出)
        vm.mov(VReg.S3, VReg.RET);         // S3 = len
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_typed_array_new");
        vm.mov(VReg.S2, VReg.RET);         // S2 = ta
        vm.movImm(VReg.S4, 0);             // i
        vm.label("_taf_obj_loop");
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_taf_obj_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_subscript_get");         // RET = obj[i](按索引读属性,coerce 由 _typed_array_set)
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_typed_array_set");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_taf_obj_loop");
        vm.label("_taf_obj_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // _ta_to_array(ta) -> 装箱普通 Array(0x7FFE)。逐元素 _typed_array_get(得 canonical
    // float64 数字)填入 _array_new_with_size 建的普通数组。这是 join/indexOf/includes/at
    // 以及 for-of/spread/Array.from 的枢纽:转成普通数组后复用久经考验的 _array_* 实现。
    generateToArray() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_to_array");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // S0 = 裸 ta
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length"); // OOB/detached→0;tracking 活长度
        vm.mov(VReg.S3, VReg.RET);      // len
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S1, VReg.RET);         // S1 = 裸普通数组
        vm.movImm(VReg.S2, 0);             // i
        vm.label("_ta_toarr_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_ta_toarr_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_typed_array_get");       // RET = 装箱数字
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_subscript_set");         // 标准下标写(经 data_ptr@24),兼容 _array_* 消费者
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_ta_toarr_loop");
        vm.label("_ta_toarr_done");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.V0, VReg.V1); // 装箱 0x7FFE
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // 复合方法(转普通数组后委托 _array_*):join/indexOf/includes/at。语义:结果是标量或
    // 普通数组(非 typed),故转换无损。参数约定与 compileArrayMethod 一致。
    generateComposedMethods() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        // _ta_join(ta, sep) -> string。规范序:Validate → 捕 len → ToString(sep)
        // → 活读元素拼接。禁先 _ta_to_array:sep.toString 可 detach,快照会留下旧值;
        // detach 后 Get → undefined → 空串(故 length=3 + detach → ",,")。
        vm.label("_ta_join");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.call("_tam_throw_if_detached");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.mov(VReg.S1, VReg.A1); // sep boxed
        vm.load(VReg.S2, VReg.S0, 8); // len(捕)
        // ToString(sep); undefined → ","
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_ta_join_comma");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_valueToStr");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_string");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_ta_join_sep_ok");
        vm.label("_ta_join_comma");
        vm.lea(VReg.S1, "_str_comma_only");
        vm.movImm64(VReg.V0, 0x7ffc000000000000n);
        vm.or(VReg.S1, VReg.S1, VReg.V0);
        vm.label("_ta_join_sep_ok");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_ta_join_empty");
        vm.lea(VReg.A0, "_str_empty");
        vm.call("_js_box_string");
        vm.mov(VReg.S4, VReg.RET); // acc
        vm.movImm(VReg.S3, 0); // k
        vm.label("_ta_join_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_ta_join_done");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_ta_join_nosep");
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_strconcat");
        vm.mov(VReg.S4, VReg.RET);
        vm.label("_ta_join_nosep");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_typed_array_get"); // detach/OOB → undefined
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_arr_elem_boxed_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_strconcat");
        vm.mov(VReg.S4, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_join_loop");
        vm.label("_ta_join_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_ta_join_empty");
        vm.lea(VReg.A0, "_str_empty");
        vm.call("_js_box_string");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        // _ta_indexof(ta, val, fromBoxed) -> 首个 _strict_eq(elem, val) 为真的下标(裸 int),否则 -1。
        // 直接逐元素比:_typed_array_get 返 canonical float,val 可能是 int 表示——_strict_eq
        // 实现 `===` 跨表示数值相等(6.0===6 为真),避 _array_indexOf 的位相等/装箱 Number 双路
        // 都不认 canonical-float 元素 vs int 搜索值的坑。(NaN 永不匹配,合 indexOf 语义。)
        // A2 = 装箱 fromIndex(undefined→0)。须在 ToInteger 前捕获 [[ArrayLength]],
        // 供 resize 副作用后的下标换算与搜索上界(只看到原长)。
        vm.label("_ta_indexof");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
        vm.mov(VReg.S2, VReg.A1);          // val
        vm.mov(VReg.S1, VReg.A2);          // boxed from(暂存)
        vm.load(VReg.S4, VReg.S0, 8);      // origLen = [[ArrayLength]](coerce 前)
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);             // 缺省 from=0
        vm.call("_aref_argint_d");
        vm.mov(VReg.S3, VReg.RET);         // from 裸 int(可能已 resize)
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");   // detached/OOB→0;tracking 跟新长
        vm.mov(VReg.S1, VReg.RET);         // curLen
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_ta_iof_nf");
        // searchLen = min(origLen, curLen) → S5
        vm.mov(VReg.S5, VReg.S4);
        vm.cmp(VReg.S5, VReg.S1);
        vm.jle("_ta_iof_have_slen");
        vm.mov(VReg.S5, VReg.S1);
        vm.label("_ta_iof_have_slen");
        // 负 fromIndex 按 origLen(S4) 换算
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_ta_iof_start");
        vm.add(VReg.S3, VReg.S3, VReg.S4);
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_ta_iof_start");
        vm.movImm(VReg.S3, 0);
        vm.label("_ta_iof_start");
        vm.cmp(VReg.S3, VReg.S5);          // fromIndex >= searchLen → not found
        vm.jge("_ta_iof_nf");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ta_iof_bi_loop");
        vm.label("_ta_iof_loop");
        vm.cmp(VReg.S3, VReg.S5);
        vm.jge("_ta_iof_nf");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_iof_found");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_iof_loop");
        vm.label("_ta_iof_bi_loop");
        vm.cmp(VReg.S3, VReg.S5);
        vm.jge("_ta_iof_nf");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_bigint_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_iof_found");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_iof_bi_loop");
        vm.label("_ta_iof_found");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_ta_iof_nf");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        // _ta_includes(ta, val, fromIndex) -> 裸 1(命中)/0(未命中)。
        // 使用 SameValueZero(_map_key_eq)而非 ===(_strict_eq)以匹配 ES 规范:
        // SameValueZero 下 NaN===NaN 为真、+0===-0 为真(与 includes 要求一致)。
        // A2 = fromIndex(裸 int,已由编译期/包装器归一)。负值加 len 后夹到 0 起步。
        vm.label("_ta_includes");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.mov(VReg.S2, VReg.A1);
        vm.mov(VReg.S3, VReg.A2);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length"); // OOB → 0
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_ta_inc_start");
        vm.add(VReg.S3, VReg.S3, VReg.S1); // fromIndex += len
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_ta_inc_start");
        vm.movImm(VReg.S3, 0);
        vm.label("_ta_inc_start");
        vm.cmp(VReg.S3, VReg.S1);          // fromIndex >= len → not found
        vm.jge("_ta_inc_nf");
        // BigInt64/BigUint64:元素与搜索值各是独立 _bigint_box,位不等。
        // _map_key_eq/_strict_eq 把高16=0 当 float → 2n!==2n。值相等走 _bigint_strict_eq。
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ta_inc_bi_loop");
        vm.label("_ta_inc_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_ta_inc_nf");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_map_key_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_inc_found");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_inc_loop");
        vm.label("_ta_inc_bi_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_ta_inc_nf");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_bigint_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_inc_found");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_inc_bi_loop");
        vm.label("_ta_inc_found");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_ta_inc_nf");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        // [W-23] _ta_lastindexof(ta, val, fromBoxed) -> 裸下标/-1。
        // 与 _ta_indexof 同构:直接 _typed_array_get+_strict_eq 反向扫。
        // A2 = 装箱 fromIndex(undefined→INT_MAX 哨兵)。coerce 前捕获 origLen。
        vm.label("_ta_lastindexof");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
        vm.mov(VReg.S2, VReg.A1);          // val
        vm.mov(VReg.S1, VReg.A2);          // boxed from
        vm.load(VReg.S4, VReg.S0, 8);      // origLen
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 2147483647);    // 缺省 INT_MAX(从末尾)
        vm.call("_aref_argint_d");
        vm.mov(VReg.S3, VReg.RET);         // from 裸 int
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.mov(VReg.S1, VReg.RET);         // curLen
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_ta_lio_nf");
        // searchLen = min(origLen, curLen) → S5
        vm.mov(VReg.S5, VReg.S4);
        vm.cmp(VReg.S5, VReg.S1);
        vm.jle("_ta_lio_have_slen");
        vm.mov(VReg.S5, VReg.S1);
        vm.label("_ta_lio_have_slen");
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_ta_lio_clamp_hi");
        vm.add(VReg.S3, VReg.S3, VReg.S4); // 负: origLen+from
        vm.label("_ta_lio_clamp_hi");
        vm.subImm(VReg.V0, VReg.S5, 1);     // searchLen-1
        vm.cmp(VReg.S3, VReg.V0);
        vm.jle("_ta_lio_pick");
        vm.mov(VReg.S3, VReg.V0);
        vm.label("_ta_lio_pick");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_bigint");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ta_lio_bi_loop");
        vm.label("_ta_lio_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_ta_lio_nf");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_lio_found");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_lio_loop");
        vm.label("_ta_lio_bi_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_ta_lio_nf");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_bigint_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_lio_found");
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_lio_bi_loop");
        vm.label("_ta_lio_found");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_ta_lio_nf");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        // _ta_at(ta, idx) -> _array_at(_ta_to_array(ta), idx)
        vm.label("_ta_at");
        vm.prologue(0, [VReg.S0]);
        vm.call("_tam_throw_if_detached");
        vm.mov(VReg.S0, VReg.A1);          // idx(裸 int)
        vm.call("_ta_to_array");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_array_at");
        vm.epilogue([VReg.S0], 0);

        // _ta_with(ta, indexBoxed, valueBoxed) -> 新 TypedArray。
        // 规范序:捕 len → ToInteger(index) → ToNumber/BigInt(value)(可 resize) →
        // IsValidIntegerIndex(当前 O)→ 否 RangeError → TypedArrayCreateSameType(«len»)
        // → 拷贝+写 actualIndex。
        vm.label("_ta_with");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.mov(VReg.S1, VReg.A1); // boxed index
        vm.mov(VReg.S2, VReg.A2); // boxed value
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_tam_throw_if_detached");
        vm.load(VReg.S3, VReg.S0, 8); // origLen
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_aref_argint_d"); // ToInteger(index)
        vm.mov(VReg.S4, VReg.RET); // relativeIndex
        vm.cmpImm(VReg.S4, 0);
        vm.jge("_taw_pos");
        vm.add(VReg.S4, VReg.S4, VReg.S3); // actualIndex = len + relative
        vm.label("_taw_pos");
        // ToNumber(value) — 触发 valueOf/resize;结果暂存,稍后 _typed_array_set 再 coerce
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_number_coerce");
        vm.mov(VReg.S5, VReg.RET); // numeric bits (or keep S2 original for set)
        // IsValidIntegerIndex: 0 <= actualIndex < current length, and not OOB
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_taw_range");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length"); // 当前长(tracking 可能已变)
        vm.cmpImm(VReg.S4, 0);
        vm.jlt("_taw_range");
        vm.cmp(VReg.S4, VReg.RET);
        vm.jge("_taw_range");
        // TypedArrayCreateSameType(«origLen»)——忽略 @@species
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_ta_create_same_type_len");
        vm.mov(VReg.S1, VReg.RET); // result
        // 拷贝 origLen 个元素(活读源;源可能已变短 → undefined→0)
        vm.movImm(VReg.S5, 0);
        vm.label("_taw_copy");
        vm.cmp(VReg.S5, VReg.S3);
        vm.jge("_taw_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_typed_array_get");
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_typed_array_set");
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_taw_copy");
        vm.label("_taw_set");
        // 仅当 actualIndex < origLen 时写入(规范在 Create 后 Set;len=0 且 index 合法于
        // 当前 O 时仍 Create(0) 不写)。actualIndex 已通过当前长度校验。
        vm.cmp(VReg.S4, VReg.S3);
        vm.jge("_taw_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S2); // 原始 value(再 ToNumber)
        vm.call("_typed_array_set");
        vm.label("_taw_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_taw_range");
        vm.lea(VReg.A0, vm.asm.addString("Invalid typed array index in %TypedArray%.prototype.with"));
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_range_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // _ta_slice(ta, start, end) -> 新 typed array(同类型,拷贝元素;带 start/end 归一)。
    // end=2147483647 表示到末尾。TypedArraySpeciesCreate 后再因 count>0 且源 detached 抛。
    generateSlice() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        const STR_TAG = 0x7ffc000000000000n;
        const UNDEF = 0x7ffb000000000000n;
        const SAVE = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, MASK); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, STR_TAG); vm.or(reg, reg, VReg.V1);
        };

        // _ta_species_ctor(A0=exemplar) -> RET=要 Construct 的构造器,或 undefined(走默认类型)。
        // SpeciesConstructor:Get("constructor")+Get(@@species);undefined/null → 默认。
        vm.label("_ta_species_ctor");
        vm.prologue(16, SAVE);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_constructor_prop");
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET);             // C
        vm.shrImm(VReg.V0, VReg.S1, 48);
        // SpeciesConstructor:C === undefined → 默认;C === null 或非 Object → TypeError。
        // 不可用 S1==0 判(float +0 位模式亦为 0,会被误判默认)。
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_tasc_default");
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_tasc_obj");
        vm.cmpImm(VReg.V0, 0x7FFF); vm.jeq("_tasc_obj");
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_tasc_obj");
        vm.cmpImm(VReg.V0, 0); vm.jne("_tasc_notobj"); // 非裸指针 → 非 Object
        // 裸堆指针:Symbol 块不是 Object(Type(Symbol) is Symbol)。
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V1, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V0, vm.ptrFloor);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jlt("_tasc_notobj");
        vm.loadByte(VReg.V0, VReg.V1, 0);
        vm.cmpImm(VReg.V0, 61); // TYPE_SYMBOL
        vm.jeq("_tasc_notobj");
        vm.jmp("_tasc_obj");
        vm.label("_tasc_notobj");
        vm.lea(VReg.A0, vm.asm.addString("constructor is not an object"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.label("_tasc_obj");
        // Get(C, @@species):先 well-known 符号(对象字面量 [Symbol.species] 存符号键),
        // miss 再试字符串 "Symbol.species"(obj[Symbol.species]= 经 getMemberPropertyName 归一)。
        vm.lea(VReg.A0, "_symwk_species");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.species"));
        boxStr(VReg.A1);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET);             // S
        vm.shrImm(VReg.V0, VReg.S2, 48);
        // undefined/null → 试字符串键;仍无则默认。数值 0 不是 null(勿用 S2==0)。
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_tasc_str");
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_tasc_str");
        vm.jmp("_tasc_got");
        vm.label("_tasc_str");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.species"));
        boxStr(VReg.A1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_tasc_inherit");
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_tasc_inherit");
        vm.jmp("_tasc_got");
        vm.label("_tasc_inherit");
        // 无自有 @@species:规范 %TypedArray%[@@species] getter 返 this。
        // 闭包无原型链,这里对用户/类构造器直接用 C;TA 蹦床与抽象 ctor 仍走默认按型。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_tasc_inh_fn");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tasc_inh_fn");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_tasc_default");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION / classinfo
        vm.jne("_tasc_default");
        vm.jmp("_tasc_inh_use");
        vm.label("_tasc_inh_fn");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_tasc_default");
        vm.load(VReg.V2, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 0xc105);
        vm.jne("_tasc_inh_use");
        vm.load(VReg.V2, VReg.V0, 8);
        vm.lea(VReg.V1, "_ta_ctor_tramp");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_tasc_default");
        vm.lea(VReg.V1, "_ta_abstract_ctor");
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_tasc_default");
        vm.label("_tasc_inh_use");
        vm.mov(VReg.S2, VReg.S1);
        vm.label("_tasc_got");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_ta_need_fn");                // IsConstructor 近似:非可调用 → TypeError
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue(SAVE, 16);
        vm.label("_tasc_default");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue(SAVE, 16);

        // _ta_species_create_len(A0=exemplar, A1=count) -> 新 TA。
        vm.label("_ta_species_create_len");
        vm.prologue(16, SAVE);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.call("_ta_species_ctor");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_tascl_def");
        vm.mov(VReg.S2, VReg.RET);             // ctor
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S3, VReg.S2, VReg.V1);
        vm.movImm(VReg.S4, 0xFF);              // 默认自定义
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S3, VReg.V1);
        vm.jlt("_tascl_go");
        vm.load(VReg.V0, VReg.S3, 0);
        vm.cmpImm(VReg.V0, 0xc105);
        vm.jne("_tascl_go");
        vm.load(VReg.V0, VReg.S3, 8);
        vm.lea(VReg.V1, "_ta_ctor_tramp");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_tascl_go");
        vm.load(VReg.S4, VReg.S3, 16);         // TA tramp → type
        vm.label("_tascl_go");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_ta_create_from_ctor");
        vm.epilogue(SAVE, 16);
        vm.label("_tascl_def");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_typed_array_new");
        vm.epilogue(SAVE, 16);

        // _ta_create_same_type_len(A0=exemplar, A1=count) -> 新 TA(同类型,忽略 species)。
        vm.label("_ta_create_same_type_len");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.mov(VReg.S1, VReg.A1);
        vm.loadByte(VReg.A0, VReg.S0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_typed_array_new");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _ta_clone_same_type(A0=ta) -> 同类型拷贝(忽略 species;活读源)。
        vm.label("_ta_clone_same_type");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_tam_throw_if_detached");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_ta_create_same_type_len");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_ta_clone_lp");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_ta_clone_done");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A2, VReg.RET); vm.mov(VReg.A0, VReg.S1); vm.mov(VReg.A1, VReg.S3);
        vm.call("_typed_array_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_clone_lp");
        vm.label("_ta_clone_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // _ta_iterator_new(A0=ta 裸/装箱, A1=kind 0/1/2) -> 装箱迭代器对象。
        // 闭包布局同 _array_iterator_new:+16 target(裸 ta) +24 index +32 kind +40 done。
        // next 时:已 done → 终态;OOB → TypeError;index>=TypedArrayLength → 终态;否则活读。
        vm.label("_ta_iterator_new");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
        vm.mov(VReg.S3, VReg.A1); // kind
        vm.call("_object_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_ta_iterator_next");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.store(VReg.S2, 16, VReg.S0); // target 裸 ta
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S2, 24, VReg.V1); // index
        vm.store(VReg.S2, 32, VReg.S3); // kind
        vm.store(VReg.S2, 40, VReg.V1); // done
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("next"));
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_self");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S1, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        vm.label("_ta_iterator_next");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.S0); // 闭包
        vm.load(VReg.V0, VReg.S0, 40); // done?
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_taiter_done");
        vm.load(VReg.S1, VReg.S0, 16); // ta
        vm.load(VReg.S2, VReg.S0, 24); // index
        // 未耗尽时 OOB → TypeError
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_taiter_len");
        vm.lea(VReg.A0, vm.asm.addString("TypedArray is out of bounds"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.label("_taiter_len");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_typed_array_length");
        vm.cmp(VReg.S2, VReg.RET);
        vm.jge("_taiter_done");
        vm.addImm(VReg.V1, VReg.S2, 1);
        vm.store(VReg.S3, 24, VReg.V1);
        vm.load(VReg.V0, VReg.S3, 32); // kind
        vm.cmpImm(VReg.V0, 1); vm.jeq("_taiter_keys");
        vm.cmpImm(VReg.V0, 2); vm.jeq("_taiter_entries");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.jmp("_taiter_emit");
        vm.label("_taiter_keys");
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A0, 0);
        vm.jmp("_taiter_emit");
        vm.label("_taiter_entries");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_typed_array_get");
        vm.mov(VReg.S1, VReg.RET); // value
        vm.movImm(VReg.A0, 2);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.scvtf(0, VReg.S2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 1);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_array_set");
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A0, VReg.S0, VReg.V1);
        vm.label("_taiter_emit");
        vm.movImm64(VReg.A1, 0x7ff9000000000000n); // done = false
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_taiter_done");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.S3, 40, VReg.V1);
        vm.movImm64(VReg.A0, UNDEF);
        vm.movImm64(VReg.A1, 0x7ff9000000000001n); // true
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // _ta_slice(A0=ta, A1=startBoxed, A2=endBoxed) -> 新 TA。
        // 规范序:Validate → 捕 srcLength → ToInteger(start/end) → count → SpeciesCreate
        // → count>0 且源 OOB/detached → TypeError → 活读拷贝(OOB 元素→0)。
        // 缺 start/end(undefined) 或 end 哨兵 2147483647 → 相对端点按 srcLength。
        vm.label("_ta_slice");
        vm.prologue(48, SAVE);
        vm.store(VReg.SP, 0, VReg.A0);         // exemplar
        vm.call("_tam_throw_if_detached");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);     // 裸 ta
        vm.store(VReg.SP, 8, VReg.A1);          // start boxed
        vm.store(VReg.SP, 16, VReg.A2);         // end boxed
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");        // 捕 srcLength(coerce 前)
        vm.mov(VReg.S3, VReg.RET);
        vm.store(VReg.SP, 24, VReg.S3);
        // ToInteger(start); undefined → 0
        vm.load(VReg.A0, VReg.SP, 8);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jne("_ta_sl_start");
        vm.movImm(VReg.S1, 0);
        vm.jmp("_ta_sl_start_done");
        vm.label("_ta_sl_start");
        vm.movImm(VReg.A1, 0);
        vm.call("_aref_argint_d");
        vm.mov(VReg.S1, VReg.RET);
        vm.label("_ta_sl_start_done");
        // ToInteger(end); undefined / INT_MAX 哨兵 → srcLength
        vm.load(VReg.A0, VReg.SP, 16);
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_ta_sl_end_def");
        vm.movImm64(VReg.V1, 2147483647n);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jeq("_ta_sl_end_def");
        vm.movImm(VReg.A1, 2147483647);
        vm.call("_aref_argint_d");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_ta_sl_end_done");
        vm.label("_ta_sl_end_def");
        vm.load(VReg.S2, VReg.SP, 24);         // relativeEnd = srcLength
        vm.label("_ta_sl_end_done");
        vm.load(VReg.S3, VReg.SP, 24);         // S3 = srcLength(归一用)
        // 归一 start → [0, srcLength]
        vm.cmpImm(VReg.S1, 0); vm.jge("_ta_sl_s1"); vm.add(VReg.S1, VReg.S1, VReg.S3); vm.label("_ta_sl_s1");
        vm.cmpImm(VReg.S1, 0); vm.jge("_ta_sl_s2"); vm.movImm(VReg.S1, 0); vm.label("_ta_sl_s2");
        vm.cmp(VReg.S1, VReg.S3); vm.jle("_ta_sl_s3"); vm.mov(VReg.S1, VReg.S3); vm.label("_ta_sl_s3");
        // 归一 end → [0, srcLength]
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_sl_e1"); vm.add(VReg.S2, VReg.S2, VReg.S3); vm.label("_ta_sl_e1");
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_sl_e2"); vm.movImm(VReg.S2, 0); vm.label("_ta_sl_e2");
        vm.cmp(VReg.S2, VReg.S3); vm.jle("_ta_sl_e3"); vm.mov(VReg.S2, VReg.S3); vm.label("_ta_sl_e3");
        vm.sub(VReg.S3, VReg.S2, VReg.S1);     // count
        vm.cmpImm(VReg.S3, 0); vm.jge("_ta_sl_l0"); vm.movImm(VReg.S3, 0); vm.label("_ta_sl_l0");
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_ta_species_create_len");
        vm.mov(VReg.S4, VReg.RET);
        vm.movImm(VReg.S5, 0);
        vm.cmpImm(VReg.S3, 0);
        vm.jle("_ta_sl_loop");                 // count==0:不因源 OOB/detached 抛
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_tam_throw_if_detached");     // detached 或 OOB → TypeError
        vm.label("_ta_sl_loop");
        vm.cmp(VReg.S5, VReg.S3); vm.jge("_ta_sl_done");
        // 仅当 k < 当前 TypedArrayLength 时拷贝;否则保留 Create 的零填充(禁 Get→undefined→NaN)
        vm.add(VReg.V0, VReg.S1, VReg.S5); // k
        vm.store(VReg.SP, 32, VReg.V0);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_typed_array_length");
        vm.load(VReg.V0, VReg.SP, 32);
        vm.cmp(VReg.V0, VReg.RET);
        vm.jge("_ta_sl_skip");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.V0); vm.call("_typed_array_get");
        vm.mov(VReg.A2, VReg.RET); vm.mov(VReg.A0, VReg.S4); vm.mov(VReg.A1, VReg.S5); vm.call("_typed_array_set");
        vm.label("_ta_sl_skip");
        vm.addImm(VReg.S5, VReg.S5, 1); vm.jmp("_ta_sl_loop");
        vm.label("_ta_sl_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue(SAVE, 48);
    }

    // _ta_fill(ta, val, start, end) -> ta(原地填充,start/end 归一;end=2147483647=到末尾)。
    generateFill() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_fill");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.call("_tam_throw_if_detached");
        vm.movImm64(VReg.V4, MASK); // (x64 V1≡A3=end 会毁实参;V4≡A5 非本函数实参)
        vm.and(VReg.S0, VReg.A0, VReg.V4); // 裸 ta
        vm.mov(VReg.S1, VReg.A1);          // val(装箱)
        vm.mov(VReg.S2, VReg.A2);          // start
        vm.mov(VReg.S3, VReg.A3);          // end
        vm.load(VReg.S4, VReg.S0, 8);      // len
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_fl_s1"); vm.add(VReg.S2, VReg.S2, VReg.S4); vm.label("_ta_fl_s1");
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_fl_s2"); vm.movImm(VReg.S2, 0); vm.label("_ta_fl_s2");
        vm.movImm64(VReg.V0, 2147483647n); vm.cmp(VReg.S3, VReg.V0); vm.jne("_ta_fl_e0"); vm.mov(VReg.S3, VReg.S4); vm.label("_ta_fl_e0");
        vm.cmpImm(VReg.S3, 0); vm.jge("_ta_fl_e1"); vm.add(VReg.S3, VReg.S3, VReg.S4); vm.label("_ta_fl_e1");
        vm.cmp(VReg.S3, VReg.S4); vm.jle("_ta_fl_e2"); vm.mov(VReg.S3, VReg.S4); vm.label("_ta_fl_e2");
        vm.label("_ta_fl_loop");
        vm.cmp(VReg.S2, VReg.S3); vm.jge("_ta_fl_done");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S2); vm.mov(VReg.A2, VReg.S1); vm.call("_typed_array_set");
        vm.addImm(VReg.S2, VReg.S2, 1); vm.jmp("_ta_fl_loop");
        vm.label("_ta_fl_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // _ta_copywithin(ta, target, start, end) -> ta(原地)。把 [start,end) 元素复制到 target 起,
    // 处理重叠(memmove 语义:重叠向前时反向拷贝)。target/start/end 归一(<0 +len、夹 [0,len];
    // end=2147483647=到末尾)。此前无 typed 专属实现 → 落 _array_* 按 data_ptr@24 读 typed 布局崩。
    generateCopyWithin() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_copywithin");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.call("_tam_throw_if_detached");
        vm.movImm64(VReg.V4, MASK); // (x64 V1≡A3=end 会毁实参;V4≡A5 非本函数实参)
        vm.and(VReg.S0, VReg.A0, VReg.V4); // 裸 ta
        vm.mov(VReg.S1, VReg.A1);          // target
        vm.mov(VReg.S2, VReg.A2);          // start
        vm.mov(VReg.S3, VReg.A3);          // end
        vm.load(VReg.S4, VReg.S0, 8);      // len
        // 归一 target
        vm.cmpImm(VReg.S1, 0); vm.jge("_ta_cw_t1"); vm.add(VReg.S1, VReg.S1, VReg.S4); vm.label("_ta_cw_t1");
        vm.cmpImm(VReg.S1, 0); vm.jge("_ta_cw_t2"); vm.movImm(VReg.S1, 0); vm.label("_ta_cw_t2");
        vm.cmp(VReg.S1, VReg.S4); vm.jle("_ta_cw_t3"); vm.mov(VReg.S1, VReg.S4); vm.label("_ta_cw_t3");
        // 归一 start
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_cw_s1"); vm.add(VReg.S2, VReg.S2, VReg.S4); vm.label("_ta_cw_s1");
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_cw_s2"); vm.movImm(VReg.S2, 0); vm.label("_ta_cw_s2");
        vm.cmp(VReg.S2, VReg.S4); vm.jle("_ta_cw_s3"); vm.mov(VReg.S2, VReg.S4); vm.label("_ta_cw_s3");
        // 归一 end(2147483647 → len)
        vm.movImm64(VReg.V0, 2147483647n); vm.cmp(VReg.S3, VReg.V0); vm.jne("_ta_cw_e0"); vm.mov(VReg.S3, VReg.S4); vm.jmp("_ta_cw_edone"); vm.label("_ta_cw_e0");
        vm.cmpImm(VReg.S3, 0); vm.jge("_ta_cw_e1"); vm.add(VReg.S3, VReg.S3, VReg.S4); vm.label("_ta_cw_e1");
        vm.cmpImm(VReg.S3, 0); vm.jge("_ta_cw_e2"); vm.movImm(VReg.S3, 0); vm.label("_ta_cw_e2");
        vm.cmp(VReg.S3, VReg.S4); vm.jle("_ta_cw_e3"); vm.mov(VReg.S3, VReg.S4); vm.label("_ta_cw_e3");
        vm.label("_ta_cw_edone");
        // count = min(end-start, len-target);<=0 无操作
        vm.sub(VReg.V0, VReg.S3, VReg.S2);   // end-start
        vm.sub(VReg.V1, VReg.S4, VReg.S1);   // len-target
        vm.cmp(VReg.V0, VReg.V1); vm.jle("_ta_cw_min"); vm.mov(VReg.V0, VReg.V1); vm.label("_ta_cw_min");
        vm.mov(VReg.S3, VReg.V0);            // S3 = count
        vm.cmpImm(VReg.S3, 0); vm.jle("_ta_cw_ret");
        // 方向:重叠向前(start<target<start+count)时反向拷贝
        vm.movImm(VReg.S4, 1);               // dir = +1(len 不再需要)
        vm.cmp(VReg.S2, VReg.S1); vm.jge("_ta_cw_loop");        // start>=target → 前向
        vm.add(VReg.V0, VReg.S2, VReg.S3);                     // start+count
        vm.cmp(VReg.S1, VReg.V0); vm.jge("_ta_cw_loop");        // target>=start+count → 前向
        vm.movImm(VReg.S4, -1);
        vm.add(VReg.S2, VReg.S2, VReg.S3); vm.subImm(VReg.S2, VReg.S2, 1); // srcIdx = start+count-1
        vm.add(VReg.S1, VReg.S1, VReg.S3); vm.subImm(VReg.S1, VReg.S1, 1); // dstIdx = target+count-1
        // 循环:S0=ta, S1=dstIdx, S2=srcIdx, S3=count, S4=dir
        vm.label("_ta_cw_loop");
        vm.cmpImm(VReg.S3, 0); vm.jle("_ta_cw_ret");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S2); vm.call("_typed_array_get");
        vm.mov(VReg.A2, VReg.RET); vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.call("_typed_array_set");
        vm.add(VReg.S2, VReg.S2, VReg.S4); vm.add(VReg.S1, VReg.S1, VReg.S4);
        vm.subImm(VReg.S3, VReg.S3, 1); vm.jmp("_ta_cw_loop");
        vm.label("_ta_cw_ret");
        vm.mov(VReg.RET, VReg.S0);           // 返回 ta(裸指针即值)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
    }

    // _ta_set(ta, src, offset) -> undefined。src(装箱普通/typed 数组/array-like)逐元素写入
    // ta[offset+i](经 _subscript_get 取 src[i]、_typed_array_set 按类型强转存)。
    //
    // [spec 23.2.3.26 守卫] 原实现无条件把 src 脱壳后当块读 srcLen@8:
    //   `ta.set(undefined)` / `ta.set(null)` → 脱壳得 0 → load [0+8] → SIGSEGV
    //   (test262 built-ins/TypedArray/prototype/set/array-arg-return-abrupt-from-toobject-offset.js
    //    的崩溃根因);`ta.set(3)` 把 NaN-boxed 双精度当地址解引用同样崩。
    // 现按规范:
    //   步骤 3   offset < 0                       → RangeError
    //   步骤 15  ToObject(undefined|null)         → TypeError
    //   srcLen:数组/TypedArray → 头 length@8;装箱对象 → ToLength(obj.length);
    //           其余原始值(number/bool/string/symbol)→ 0(ToObject 成功但无 length,no-op)
    //   步骤 17  srcLen + offset > ta.length      → RangeError
    generateSetMethod() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_set");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.call("_tam_throw_if_detached");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
        vm.mov(VReg.S1, VReg.A1);          // src(装箱)
        vm.mov(VReg.S2, VReg.A2);          // offset(装箱或裸 int;见下)
        // ---- offset:ToIntegerOrInfinity ----
        // undefined → 0; ±Infinity → RangeError; Symbol → TypeError;
        // 其余 → ToInt32。Symbol 是裸堆指针(high16=0),不可当 raw int。
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_tas_off_zero");           // undefined
        // ±Inf:指数全 1、尾数 0(高 12 位含符号后为 0x7FF / 0xFFF)
        vm.shrImm(VReg.V1, VReg.S2, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7FF);
        vm.cmpImm(VReg.V1, 0x7FF);
        vm.jne("_tas_off_notinf");
        vm.movImm64(VReg.V0, 0x000FFFFFFFFFFFFFn);
        vm.and(VReg.V0, VReg.S2, VReg.V0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tas_range");              // ±Infinity → RangeError
        vm.label("_tas_off_notinf");
        vm.shrImm(VReg.V0, VReg.S2, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tas_off_toint");          // 装箱数/其它 tag → ToInt32
        // high16=0:裸小整数 / 堆指针(Symbol 等)
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tas_off_sym");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jlt("_tas_off_ok");             // 小整数直接用
        // 堆对象(含 Number 盒)→ ToInt32(走 valueOf/Symbol 抛错)
        vm.label("_tas_off_toint");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_to_int32");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_tas_off_ok");
        vm.label("_tas_off_sym");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert a Symbol value to a number"));
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.label("_tas_off_zero");
        vm.movImm(VReg.S2, 0);
        vm.label("_tas_off_ok");
        // [步骤 3] offset < 0 → RangeError
        vm.cmpImm(VReg.S2, 0); vm.jlt("_tas_range");
        // ToInteger(offset) 之后若 targetBuffer 已 detach → TypeError
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_detached");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tas_detached_after");
        // ---- src:ToObject(primitives) ----
        // string/number/bool → wrapper 后走 array-like;null/undefined 仍 TypeError。
        // 注意:+0.0 位全 0(high16=0),不可当裸空指针落入 _tas_type。
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFC); vm.jeq("_tas_toobj_str");
        vm.cmpImm(VReg.V0, 0x7FF9); vm.jeq("_tas_toobj_bool");
        vm.cmpImm(VReg.V0, 0x7FF8); vm.jeq("_tas_toobj_num");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tas_toobj_hi");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_tas_toobj_num");          // +0.0 → Number(0)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tas_src_sym_noop");       // Symbol → ToObject 有包装但无 length → 空源
        vm.jmp("_tas_src_tag");            // 裸堆(TA/对象)
        vm.label("_tas_toobj_hi");
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jge("_tas_src_tag"); // null/undefined/obj/arr/fn
        // 其余(裸 float NaN/有限)→ Number wrapper
        vm.label("_tas_toobj_num");
        vm.mov(VReg.A0, VReg.S1); vm.call("_number_new");
        vm.mov(VReg.S1, VReg.RET); vm.jmp("_tas_src_tag");
        vm.label("_tas_toobj_bool");
        vm.mov(VReg.A0, VReg.S1); vm.call("_boolean_new");
        vm.mov(VReg.S1, VReg.RET); vm.jmp("_tas_src_tag");
        vm.label("_tas_toobj_str");
        vm.mov(VReg.A0, VReg.S1); vm.call("_string_new");
        vm.mov(VReg.S1, VReg.RET); vm.jmp("_tas_src_tag");
        vm.label("_tas_src_sym_noop");
        vm.movImm(VReg.S3, 0); vm.jmp("_tas_lenok");
        vm.label("_tas_src_tag");
        // ---- srcLen 判别(按 NaN-boxing tag) ----
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB); vm.jeq("_tas_type");   // undefined → TypeError
        vm.cmpImm(VReg.V0, 0x7FFA); vm.jeq("_tas_type");   // null → TypeError
        vm.cmpImm(VReg.V0, 0x7FFE); vm.jeq("_tas_len8");   // 普通数组 → length@8
        vm.cmpImm(VReg.V0, 0x7FFD); vm.jeq("_tas_obj");    // 装箱对象 → obj.length
        vm.cmpImm(VReg.V0, 0); vm.jeq("_tas_raw");         // 裸指针 → 验头
        vm.movImm(VReg.S3, 0); vm.jmp("_tas_lenok");       // 其余原始值 → 空源(no-op)
        // 裸指针:0 视作 null;仅 TYPE_ARRAY / TypedArray 族头才有 length@8
        vm.label("_tas_raw");
        vm.cmpImm(VReg.S1, 4095); vm.jle("_tas_type");     // 空页/小整数误当指针 → TypeError
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY); vm.jeq("_tas_len8");
        vm.cmpImm(VReg.V1, TYPE_INT8_ARRAY); vm.jlt("_tas_len0");
        vm.cmpImm(VReg.V1, TYPE_FLOAT64_ARRAY); vm.jgt("_tas_len0");
        vm.jmp("_tas_len8");
        vm.label("_tas_len0");
        vm.movImm(VReg.S3, 0); vm.jmp("_tas_lenok");
        vm.label("_tas_len8");
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.S3, VReg.V0, 8);      // srcLen
        vm.jmp("_tas_lenok");
        // 装箱对象:array-like → ToLength(obj.length)。Symbol → TypeError;
        // valueOf/getter abrupt 经 _to_int32/_number_coerce 传播(勿用 _syscall_arg)。
        vm.label("_tas_obj");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);           // this = src(触发 length getter)
        vm.call("_maybe_getter");
        vm.mov(VReg.S3, VReg.RET);         // boxed length
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_is_symbol");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tas_off_sym");            // 复用 Symbol→TypeError
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_to_int32");              // ToNumber+截断;valueOf 可 abrupt
        vm.mov(VReg.S3, VReg.RET);
        vm.cmpImm(VReg.S3, 0); vm.jge("_tas_lenok");
        vm.movImm(VReg.S3, 0);
        // [步骤 17] srcLen + offset > ta.length → RangeError。
        // 注意:offset > length 时即便 srcLen=0 也要抛(0+2>1);不可先把 avail 夹成 0。
        vm.label("_tas_lenok");
        vm.load(VReg.V0, VReg.S0, 8);      // ta.length
        vm.cmp(VReg.S2, VReg.V0);
        vm.jgt("_tas_range");              // offset > length
        vm.sub(VReg.V0, VReg.V0, VReg.S2); // avail = length - offset
        vm.cmp(VReg.S3, VReg.V0); vm.jle("_tas_lenok2");
        vm.jmp("_tas_range");
        vm.label("_tas_lenok2");
        vm.cmpImm(VReg.S3, 0); vm.jge("_tas_loop_ready");
        vm.movImm(VReg.S3, 0);
        vm.label("_tas_loop_ready");
        vm.movImm(VReg.S4, 0);             // i
        vm.label("_tas_loop");             // 注意:避开 _typed_array_set 的 _ta_set_* 标签(碰撞会毁控制流)
        vm.cmp(VReg.S4, VReg.S3); vm.jge("_tas_done");
        vm.mov(VReg.A0, VReg.S1); vm.mov(VReg.A1, VReg.S4); vm.call("_subscript_get"); // src[i]
        vm.mov(VReg.A2, VReg.RET);
        vm.add(VReg.A1, VReg.S2, VReg.S4); // offset+i
        vm.mov(VReg.A0, VReg.S0); vm.call("_typed_array_set");
        vm.addImm(VReg.S4, VReg.S4, 1); vm.jmp("_tas_loop");
        vm.label("_tas_done");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_tas_type");
        vm.lea(VReg.A0, vm.asm.addString("Cannot convert undefined or null to object"));
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0); // 理论不达
        vm.label("_tas_detached_after");
        vm.call("_ta_throw_detached"); // TypeError,不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
        vm.label("_tas_range");
        vm.call("_ta_throw_range");   // RangeError,不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0); // 理论不达
    }

    // _ta_elem_size(ta) -> 元素字节数(裸 int)。按 type 字节:1字节(0x40/0x50/0x54)、
    // 2字节(0x41/0x51)、4字节(0x42/0x52/0x60)、其余 8字节(0x43/0x53/0x61)。
    generateElemSize() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_elem_size");
        vm.prologue(0, [VReg.S0]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.loadByte(VReg.V0, VReg.S0, 0);      // type 字节
        vm.cmpImm(VReg.V0, TYPE_INT8_ARRAY); vm.jeq("_taes_1");
        vm.cmpImm(VReg.V0, TYPE_UINT8_ARRAY); vm.jeq("_taes_1");
        vm.cmpImm(VReg.V0, TYPE_UINT8_CLAMPED_ARRAY); vm.jeq("_taes_1");
        vm.cmpImm(VReg.V0, TYPE_INT16_ARRAY); vm.jeq("_taes_2");
        vm.cmpImm(VReg.V0, TYPE_UINT16_ARRAY); vm.jeq("_taes_2");
        vm.cmpImm(VReg.V0, TYPE_INT32_ARRAY); vm.jeq("_taes_4");
        vm.cmpImm(VReg.V0, TYPE_UINT32_ARRAY); vm.jeq("_taes_4");
        vm.cmpImm(VReg.V0, TYPE_FLOAT32_ARRAY); vm.jeq("_taes_4");
        vm.movImm(VReg.RET, 8); vm.jmp("_taes_done");
        vm.label("_taes_1"); vm.movImm(VReg.RET, 1); vm.jmp("_taes_done");
        vm.label("_taes_2"); vm.movImm(VReg.RET, 2); vm.jmp("_taes_done");
        vm.label("_taes_4"); vm.movImm(VReg.RET, 4);
        vm.label("_taes_done");
        vm.epilogue([VReg.S0], 0);

        // _ta_elem_size_of_type(A0=type 字节) -> 元素字节数。同表,但收的是**类型码**
        // (视图刚建好、长度可能为 0 时无法由 byteLength 反推元素宽度)。
        vm.label("_ta_elem_size_of_type");
        vm.cmpImm(VReg.A0, TYPE_INT8_ARRAY); vm.jeq("_taest_1");
        vm.cmpImm(VReg.A0, TYPE_UINT8_ARRAY); vm.jeq("_taest_1");
        vm.cmpImm(VReg.A0, TYPE_UINT8_CLAMPED_ARRAY); vm.jeq("_taest_1");
        vm.cmpImm(VReg.A0, TYPE_INT16_ARRAY); vm.jeq("_taest_2");
        vm.cmpImm(VReg.A0, TYPE_UINT16_ARRAY); vm.jeq("_taest_2");
        vm.cmpImm(VReg.A0, TYPE_INT32_ARRAY); vm.jeq("_taest_4");
        vm.cmpImm(VReg.A0, TYPE_UINT32_ARRAY); vm.jeq("_taest_4");
        vm.cmpImm(VReg.A0, TYPE_FLOAT32_ARRAY); vm.jeq("_taest_4");
        vm.movImm(VReg.RET, 8);
        vm.ret();
        vm.label("_taest_1"); vm.movImm(VReg.RET, 1); vm.ret();
        vm.label("_taest_2"); vm.movImm(VReg.RET, 2); vm.ret();
        vm.label("_taest_4"); vm.movImm(VReg.RET, 4); vm.ret();
    }

    // _ta_bytelength(ta) -> length * elemSize(装箱数字,经 boxIntAsNumber 前的裸 int)。
    generateByteLengthMethod() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_bytelength");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_detached");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tabl_zero");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_tabl_ok");
        vm.label("_tabl_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_tabl_ok");
        vm.load(VReg.S1, VReg.S0, 8);          // length
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_elem_size");              // RET = elemSize
        vm.mul(VReg.RET, VReg.S1, VReg.RET);   // length * elemSize
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _ta_reverse(ta) -> ta(原地反转,双指针 swap)。
    generateReverse() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_reverse");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.call("_tam_throw_if_detached");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.load(VReg.S1, VReg.S0, 8);          // len
        vm.movImm(VReg.S2, 0);                 // i
        vm.subImm(VReg.S3, VReg.S1, 1);        // j = len-1
        vm.label("_ta_rev_loop");
        vm.cmp(VReg.S2, VReg.S3); vm.jge("_ta_rev_done");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S2); vm.call("_typed_array_get"); vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get"); vm.mov(VReg.S5, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S2); vm.mov(VReg.A2, VReg.S5); vm.call("_typed_array_set");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.mov(VReg.A2, VReg.S4); vm.call("_typed_array_set");
        vm.addImm(VReg.S2, VReg.S2, 1); vm.subImm(VReg.S3, VReg.S3, 1); vm.jmp("_ta_rev_loop");
        vm.label("_ta_rev_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // [W-32/K7] _ta_sort_cmp(ta, comparefn) -> ta(原地插入排序)。
    //   comparefn === undefined → 数值升序(TypedArray 默认数值序,与数组 sort 的字典序不同);
    //   否则 comparefn 必须可调用(不可调用 → TypeError,ES 22.2.3.26 步骤 1),
    //   次序由 comparefn(a, b) 的 ToNumber 结果决定(>0 交换;NaN 视作 +0 → 保持稳定)。
    // _ta_sort(ta) 是**兼容入口**:编译期静态 TypedArray 路径(compiler/expressions/expressions.js
    // 的 compileTypedArrayMethod)只传 A0、且根本不求值比较器实参,故这里显式置
    // comparefn=undefined 后落入同一实现——绝不嗅探 A1(那是未初始化的残留值)。
    generateSortMethod() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        const UNDEF = 0x7ffb000000000000n;
        vm.label("_ta_sort");
        vm.movImm64(VReg.A1, UNDEF);           // 静态路径:无比较器
        // fallthrough → _ta_sort_cmp
        vm.label("_ta_sort_cmp");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.call("_tam_throw_if_detached");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.store(VReg.SP, 0, VReg.A1);         // comparefn(装箱)落栈槽:跨回调存活且 GC 可见
        vm.load(VReg.S1, VReg.S0, 8);          // len
        vm.shrImm(VReg.V0, VReg.A1, 48);
        vm.cmpImm(VReg.V0, 0x7ffb);            // undefined → 数值序
        vm.jeq("_ta_sort_numeric");
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_ta_need_fn");                // 非可调用 → TypeError(不返回)
        vm.movImm(VReg.S2, 1);                 // i
        vm.label("_ta_sortc_outer");
        vm.cmp(VReg.S2, VReg.S1); vm.jge("_ta_sortc_done");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S2); vm.call("_typed_array_get"); vm.mov(VReg.S4, VReg.RET); // key
        vm.mov(VReg.S3, VReg.S2);              // j = i
        vm.label("_ta_sortc_inner");
        vm.cmpImm(VReg.S3, 0); vm.jle("_ta_sortc_place");
        vm.subImm(VReg.A1, VReg.S3, 1);
        vm.mov(VReg.A0, VReg.S0); vm.call("_typed_array_get"); vm.mov(VReg.S5, VReg.RET); // prev = ta[j-1]
        // comparefn(prev, key):元素本身就是 canonical f64(= 装箱数字),直接当实参。
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S4);
        vm.movImm64(VReg.A2, UNDEF);
        vm.load(VReg.A3, VReg.SP, 0);
        vm.call("_aref_invoke_cb");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_number_coerce");             // ToNumber(结果)→ canonical f64
        vm.fmovToFloat(0, VReg.RET);
        vm.movImm(VReg.V1, 0); vm.scvtf(1, VReg.V1); // d1 = 0.0
        vm.fcmp(0, 1);
        vm.jfgt("_ta_sortc_shift");            // >0 → prev 应排在 key 之后;NaN 落 place(视作 0)
        vm.jmp("_ta_sortc_place");
        vm.label("_ta_sortc_shift");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.mov(VReg.A2, VReg.S5); vm.call("_typed_array_set");
        vm.subImm(VReg.S3, VReg.S3, 1); vm.jmp("_ta_sortc_inner");
        vm.label("_ta_sortc_place");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.mov(VReg.A2, VReg.S4); vm.call("_typed_array_set");
        vm.addImm(VReg.S2, VReg.S2, 1); vm.jmp("_ta_sortc_outer");
        vm.label("_ta_sortc_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);

        vm.label("_ta_sort_numeric");
        // TypedArray 默认 SortCompare:NaN 恒大于任何非 NaN(排到末尾);
        // −0 < +0;其余按数值升序。IEEE fcmp 对 NaN 无序、对 ±0 相等,须特判。
        vm.movImm(VReg.S2, 1);                 // i
        vm.label("_ta_sort_outer");
        vm.cmp(VReg.S2, VReg.S1); vm.jge("_ta_sort_done");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S2); vm.call("_typed_array_get"); vm.mov(VReg.S4, VReg.RET); // key
        vm.mov(VReg.S3, VReg.S2);              // j = i
        vm.label("_ta_sort_inner");
        vm.cmpImm(VReg.S3, 0); vm.jle("_ta_sort_place"); // j<=0 → place
        vm.subImm(VReg.A1, VReg.S3, 1);        // A1 = j-1
        vm.mov(VReg.A0, VReg.S0); vm.call("_typed_array_get"); vm.mov(VReg.S5, VReg.RET); // prev = ta[j-1]
        // key 是 NaN → 已在已排序前缀右侧,直接 place(NaN 冒泡到末尾)
        vm.fmovToFloat(1, VReg.S4);
        vm.fcmp(1, 1);
        vm.jnan("_ta_sort_place");
        // prev 是 NaN、key 不是 → NaN 更大,须右移
        vm.fmovToFloat(0, VReg.S5);
        vm.fcmp(0, 0);
        vm.jnan("_ta_sort_shift");
        vm.fmovToFloat(0, VReg.S5); vm.fmovToFloat(1, VReg.S4); vm.fcmp(0, 1);
        vm.jflt("_ta_sort_place");             // prev < key → place
        vm.jfgt("_ta_sort_shift");             // prev > key → shift
        // fcmp 相等:含真相等与 +0/−0。TypedArray:+0 > −0 → prev=+0 且 key=−0 时 shift
        vm.cmpImm(VReg.S5, 0);
        vm.jne("_ta_sort_place");              // prev 非 +0 → 真相等,place
        vm.movImm64(VReg.V0, 0x8000000000000000n); // −0 位型
        vm.cmp(VReg.S4, VReg.V0);
        vm.jne("_ta_sort_place");              // key 非 −0 → place
        vm.label("_ta_sort_shift");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.mov(VReg.A2, VReg.S5); vm.call("_typed_array_set"); // ta[j]=prev
        vm.subImm(VReg.S3, VReg.S3, 1); vm.jmp("_ta_sort_inner");
        vm.label("_ta_sort_place");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.mov(VReg.A2, VReg.S4); vm.call("_typed_array_set"); // ta[j]=key
        vm.addImm(VReg.S2, VReg.S2, 1); vm.jmp("_ta_sort_outer");
        vm.label("_ta_sort_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
    }

    // [W-32/K1] _ta_need_fn(A0=装箱候选) —— 回调/比较器的可调用性守卫。
    // 判据比 _aref_invoke_cb 的守卫**更严**:后者放行任意装箱对象(0x7FFD),非 Proxy
    // 时落 "裸函数" 分支直接 callIndirect 到对象首地址 → `ta.find({})` SIGBUS。
    // 这里只接受:装箱函数(0x7FFF) / 堆内闭包块(magic@0==0xc105) / 可调用 Proxy(type@0==8)。
    // 其余(数字、字符串、null、undefined、普通对象、数组)一律 TypeError。
    generateNeedFn() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_need_fn");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_tanf_ok");                    // 装箱函数(裸函数指针/闭包)
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tanf_raw");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_tanf_bad");
        vm.label("_tanf_raw");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.S0, VReg.V1);
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_tanf_bad");
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_tanf_bad");
        vm.load(VReg.V0, VReg.S0, 0);
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_tanf_ok");                    // 闭包块
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 3);                 // classinfo / TYPE_FUNCTION
        vm.jeq("_tanf_ok");
        vm.cmpImm(VReg.V0, 8);                 // TYPE_PROXY(可调用 Proxy 候选)
        vm.jeq("_tanf_ok");
        vm.label("_tanf_bad");
        vm.call("_throw_not_a_function");      // 不返回
        vm.label("_tanf_ok");
        vm.epilogue([VReg.S0], 0);
    }

    // [W-32/K7] _ta_subarray(ta, begin, end) -> **共享同一 buffer 的视图**(不拷贝)。
    // ES 22.2.3.27:subarray 返回 view,写回互见、`sub.buffer === src.buffer`。
    // 原实现走 _ta_slice(整段拷贝),别名写不回传——真实程序里静默丢数据。
    // 实现:_ta_buffer 取(或惰性建)底层 ArrayBuffer,再 _typed_array_view 造视图,
    // byteOffset = 源 byteOffset + begin*elemSize。begin/end 归一同 slice(夹到 [0,len],
    // 负数加 len,2147483647 = 到末尾哨兵),count<0 归 0 —— 故不会触发 view 的 RangeError。
    generateSubarray() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_subarray");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.store(VReg.SP, 0, VReg.A0);          // 装箱/裸源
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);      // 裸 ta
        vm.mov(VReg.S1, VReg.A1);               // begin
        vm.mov(VReg.S2, VReg.A2);               // end
        vm.load(VReg.S3, VReg.S0, 8);           // len
        vm.cmpImm(VReg.S1, 0); vm.jge("_ta_sub_s1"); vm.add(VReg.S1, VReg.S1, VReg.S3); vm.label("_ta_sub_s1");
        vm.cmpImm(VReg.S1, 0); vm.jge("_ta_sub_s2"); vm.movImm(VReg.S1, 0); vm.label("_ta_sub_s2");
        vm.cmp(VReg.S1, VReg.S3); vm.jle("_ta_sub_s3"); vm.mov(VReg.S1, VReg.S3); vm.label("_ta_sub_s3");
        vm.movImm64(VReg.V0, 2147483647n); vm.cmp(VReg.S2, VReg.V0); vm.jne("_ta_sub_e0"); vm.mov(VReg.S2, VReg.S3); vm.jmp("_ta_sub_edone"); vm.label("_ta_sub_e0");
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_sub_e1"); vm.add(VReg.S2, VReg.S2, VReg.S3); vm.label("_ta_sub_e1");
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_sub_e2"); vm.movImm(VReg.S2, 0); vm.label("_ta_sub_e2");
        vm.cmp(VReg.S2, VReg.S3); vm.jle("_ta_sub_e3"); vm.mov(VReg.S2, VReg.S3); vm.label("_ta_sub_e3");
        vm.label("_ta_sub_edone");
        vm.sub(VReg.S3, VReg.S2, VReg.S1);
        vm.cmpImm(VReg.S3, 0); vm.jge("_ta_sub_c0"); vm.movImm(VReg.S3, 0); vm.label("_ta_sub_c0");
        vm.store(VReg.SP, 24, VReg.S3);         // count
        vm.mov(VReg.A0, VReg.S0); vm.call("_ta_elem_size"); vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.call("_ta_buffer");    vm.store(VReg.SP, 8, VReg.RET);
        vm.mov(VReg.A0, VReg.S0); vm.call("_ta_byteoffset");
        vm.mov(VReg.S5, VReg.RET);              // [[ByteOffset]](x64 V0≡RET,mul 前先落 S)
        vm.mul(VReg.V0, VReg.S1, VReg.S4);
        vm.add(VReg.V0, VReg.V0, VReg.S5);
        vm.store(VReg.SP, 16, VReg.V0);         // beginByteOffset
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_ta_species_ctor");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_ta_sub_def");
        vm.mov(VReg.S1, VReg.RET);              // custom ctor
        vm.movImm(VReg.A0, 3);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2); vm.movImm(VReg.A1, 0);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_array_set");
        vm.load(VReg.V0, VReg.SP, 16);
        vm.scvtf(0, VReg.V0); vm.fmovToInt(VReg.A2, 0);
        vm.mov(VReg.A0, VReg.S2); vm.movImm(VReg.A1, 1);
        vm.call("_array_set");
        vm.load(VReg.V0, VReg.SP, 24);
        vm.scvtf(0, VReg.V0); vm.fmovToInt(VReg.A2, 0);
        vm.mov(VReg.A0, VReg.S2); vm.movImm(VReg.A1, 2);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.movImm(VReg.A2, 0);
        vm.call("_fn_construct_call");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_tam_validate");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_tam_throw_if_detached");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
        vm.label("_ta_sub_def");
        vm.load(VReg.A0, VReg.S0, 0); vm.andImm(VReg.A0, VReg.A0, 0xff);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.load(VReg.A3, VReg.SP, 24);
        vm.call("_typed_array_view");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
    }

    generate() {
        this.generateNew();
        this.generateView();
        this.generateGet();
        this.generateSet();
        this.generateLength();
        this.generateTypedArrayFrom();
        this.generateToArray();
        this.generateComposedMethods();
        this.generateSlice();
        this.generateFill();
        this.generateCopyWithin();
        this.generateSetMethod();
        this.generateElemSize();
        this.generateByteLengthMethod();
        this.generateReverse();
        this.generateSortMethod();
        this.generateNeedFn();
        this.generateTaBuffer();
        this.generateTaByteOffset();
        this.generateSubarray();
        this.generateCtorSupport();
        this.generateProtoIntrinsic();
        this.generateAbProtoFill();
    }

    // [resizable AB] _ab_proto_fill(A0=装箱 ArrayBuffer.prototype) —— 往该单例挂
    // resize/slice 方法与 byteLength/maxByteLength/resizable 访问器。
    // 动机:harness/testTypedArray.js:106 是 `if (ArrayBuffer.prototype.resize)`,
    // 属性缺失时整套 makeResizableArrayBuffer/makeGrown/makeShrunk 工厂都不定义,
    // 于是所有按工厂表循环的 TypedArray 用例判「undefined 不是 function」而整簇失败。
    // 方法值形状与 %TypedArray%.prototype 一致({0xc105, _aref_generic, helper@16}),
    // 复用既有蹦床:接收者进 A0、实参上移。
    generateAbProtoFill() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        const STR_TAG = 0x7ffc000000000000n;
        const INT_MAX = 2147483647;
        const ATTR_W_C = 1 | 4;
        const SAVE = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, MASK); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, STR_TAG); vm.or(reg, reg, VReg.V1);
        };
        const keyOf = (reg, name) => { vm.lea(reg, vm.asm.addString(name)); boxStr(reg); };
        const boxIntReg = (reg) => { vm.scvtf(0, reg); vm.fmovToInt(reg, 0); };

        // ---- _abm_validate(A0=接收者) -> RET = 裸 ArrayBuffer;否则 TypeError。
        vm.label("_abm_validate");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_abmv_ptr");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_abmv_bad");
        vm.label("_abmv_ptr");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_abmv_bad");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.jne("_abmv_bad");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_abmv_bad");
        vm.lea(VReg.A0, vm.asm.addString("ArrayBuffer.prototype method called on incompatible receiver"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0], 0);

        const wrap = (label, body) => {
            vm.label(label);
            vm.prologue(48, SAVE);
            vm.mov(VReg.S1, VReg.A1);
            vm.mov(VReg.S2, VReg.A2);
            vm.call("_abm_validate");      // A0 仍是接收者
            vm.mov(VReg.S0, VReg.RET);     // S0 = 裸 buffer
            body();
            vm.epilogue(SAVE, 48);
        };
        const argInt = (src, d) => {
            vm.mov(VReg.A0, src);
            vm.movImm(VReg.A1, d);
            vm.call("_aref_argint_d");
        };

        wrap("_abm_resize", () => {
            argInt(VReg.S1, 0);
            vm.mov(VReg.A1, VReg.RET);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_arraybuffer_resize");
        });
        wrap("_abm_slice", () => {
            argInt(VReg.S1, 0); vm.mov(VReg.S4, VReg.RET);
            argInt(VReg.S2, INT_MAX); vm.mov(VReg.S5, VReg.RET);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S4); vm.mov(VReg.A2, VReg.S5);
            vm.call("_arraybuffer_slice");
        });
        wrap("_abg_byteLength", () => {
            vm.load(VReg.RET, VReg.S0, 8);
            boxIntReg(VReg.RET);
        });
        // 规范:非 resizable 的 maxByteLength 返回 byteLength(不是 0/undefined)。
        wrap("_abg_maxByteLength", () => {
            vm.load(VReg.RET, VReg.S0, 32);
            vm.cmpImm(VReg.RET, 0);
            vm.jge("_abg_mbl_have");
            vm.load(VReg.RET, VReg.S0, 8);
            vm.label("_abg_mbl_have");
            boxIntReg(VReg.RET);
        });
        wrap("_abg_resizable", () => {
            vm.load(VReg.V2, VReg.S0, 32);
            vm.cmpImm(VReg.V2, 0);
            vm.jge("_abg_rz_true");
            vm.movImm64(VReg.RET, 0x7ff9000000000000n);
            vm.jmp("_abg_rz_done");
            vm.label("_abg_rz_true");
            vm.movImm64(VReg.RET, 0x7ff9000000000001n);
            vm.label("_abg_rz_done");
        });

        // ---- _ab_proto_fill(A0=装箱原型) ----
        vm.label("_ab_proto_fill");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A0);            // S1 = 装箱原型
        for (const [name, arity, helper] of [
            ["resize", 1, "_abm_resize"], ["slice", 2, "_abm_slice"],
        ]) {
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");
            vm.mov(VReg.S2, VReg.RET);
            vm.movImm(VReg.V1, 0xc105);
            vm.store(VReg.S2, 0, VReg.V1);
            vm.lea(VReg.V1, "_aref_generic");
            vm.store(VReg.S2, 8, VReg.V1);
            vm.lea(VReg.V1, helper);
            vm.store(VReg.S2, 16, VReg.V1);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_js_box_function");
            vm.mov(VReg.S2, VReg.RET);
            vm.mov(VReg.A0, VReg.S2);
            keyOf(VReg.A1, "name");
            vm.lea(VReg.A2, vm.asm.addString(name)); boxStr(VReg.A2);
            vm.call("_closure_prop_define");
            vm.mov(VReg.A0, VReg.S2);
            keyOf(VReg.A1, "length");
            vm.movImm(VReg.A2, arity);
            boxIntReg(VReg.A2);
            vm.call("_closure_prop_define");
            vm.movImm64(VReg.V1, MASK);
            vm.and(VReg.A0, VReg.S1, VReg.V1);
            keyOf(VReg.A1, name);
            vm.mov(VReg.A2, VReg.S2);
            vm.call("_object_define");
            vm.mov(VReg.A0, VReg.S1);
            keyOf(VReg.A1, name);
            vm.movImm(VReg.A2, ATTR_W_C);
            vm.call("_object_set_prop_attr");
        }
        for (const [name, getter] of [
            ["byteLength", "_abg_byteLength"], ["maxByteLength", "_abg_maxByteLength"],
            ["resizable", "_abg_resizable"],
        ]) {
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");
            vm.mov(VReg.S2, VReg.RET);         // 裸 getter 闭包
            vm.movImm(VReg.V1, 0xc105);
            vm.store(VReg.S2, 0, VReg.V1);
            vm.lea(VReg.V1, "_aref_generic");
            vm.store(VReg.S2, 8, VReg.V1);
            vm.lea(VReg.V1, getter);
            vm.store(VReg.S2, 16, VReg.V1);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_js_box_function");
            vm.mov(VReg.S3, VReg.RET);         // 装箱 getter(挂 name/length)
            vm.mov(VReg.A0, VReg.S3);
            keyOf(VReg.A1, "name");
            vm.lea(VReg.A2, vm.asm.addString("get " + name)); boxStr(VReg.A2);
            vm.call("_closure_prop_define");
            vm.mov(VReg.A0, VReg.S3);
            keyOf(VReg.A1, "length");
            vm.movImm(VReg.A2, 0);
            boxIntReg(VReg.A2);
            vm.call("_closure_prop_define");
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");                 // TYPE_GETTER 标记块
            vm.movImm(VReg.V1, 60);
            vm.store(VReg.RET, 0, VReg.V1);
            vm.store(VReg.RET, 8, VReg.S2);
            vm.movImm(VReg.V1, 0);
            vm.store(VReg.RET, 16, VReg.V1);
            vm.mov(VReg.S2, VReg.RET);
            vm.movImm64(VReg.V1, MASK);
            vm.and(VReg.A0, VReg.S1, VReg.V1);
            keyOf(VReg.A1, name);
            vm.mov(VReg.A2, VReg.S2);
            vm.call("_object_define");
            vm.mov(VReg.A0, VReg.S1);
            keyOf(VReg.A1, name);
            vm.movImm(VReg.A2, 4);             // configurable only
            vm.call("_object_set_prop_attr");
        }
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
    }

    // [Design A] _ta_buffer(boxed ta) -> 底层 ArrayBuffer。
    // buffer@24!=0(视图,或内联已缓存 wrapper)→ 直接返回它(→ ta.buffer===ta.buffer 稳定,
    // 多视图/DataView 共享真 buffer)。内联首访 → 建 wrapper 别名 data_ptr@16、owner=ta,
    // 缓存进 buffer@24。
    generateTaBuffer() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_buffer");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);          // ta(装箱 0x7FFD 或裸指针)
        // [buffer-untyped] 接收者非 TA(用户对象 .buffer 属性)时回落通用具名读:
        // 编译器把 .buffer 访问点无条件改派到这里(参数/别名接收者静态不可判),
        // 若不回落,用户对象的同名属性被劫持成垃圾。TA 头字节 0x40..0x61,
        // 装箱/裸指针两种表示都要认(_typed_array_new 返裸指针,多数流不装箱)。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_tab_chk_head");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tab_user");               // 数字/bool/字符串等 → 用户属性读
        vm.label("_tab_chk_head");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        // DataView(14):buffer 在 @32,不是 TA 的 @24。type 14 < 0x40 会误落用户属性读
        // → new DataView(ab).buffer / class DV extends DataView 的 dv.buffer 得 undefined。
        vm.cmpImm(VReg.V1, TYPE_DATA_VIEW);
        vm.jeq("_tab_dv");
        vm.cmpImm(VReg.V1, 0x40);
        vm.jlt("_tab_user");
        vm.cmpImm(VReg.V1, 0x61);
        vm.jgt("_tab_user");
        vm.mov(VReg.S1, VReg.V0);          // S1 = 裸 ta
        vm.load(VReg.V0, VReg.S1, 24);     // buffer@24
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tab_make");
        vm.mov(VReg.RET, VReg.V0);         // 返回已有 buffer
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_tab_make");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_ta_bytelength");         // RET = byteLength(S0/S1 callee 保存)
        vm.mov(VReg.A1, VReg.RET);         // byteLength(先存,arm64 上 A0==RET,后面 load 会覆盖)
        vm.load(VReg.A0, VReg.S1, 16);     // data_ptr@16
        vm.mov(VReg.A2, VReg.S0);          // owner = boxed ta
        vm.call("_arraybuffer_wrap");      // RET = wrapper(S1 callee 保存)
        vm.store(VReg.S1, 24, VReg.RET);   // 缓存 ta.buffer@24 = wrapper
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_tab_dv");
        vm.mov(VReg.S1, VReg.V0);
        vm.load(VReg.RET, VReg.S1, 32);     // DataView.buffer@32(_dataview_new 写入的 AB)
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_tab_user");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("buffer"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // ---- _ta_bytelength_prop(A0=接收者) -> 装箱 byteLength。
        // 静态类型未知的接收者(`new ctor(rab).byteLength`、形参 TA)也要拿到正确值:
        // TA → length*elemSize;ArrayBuffer → byteLength@8;其余回落通用具名读
        // (不劫持用户对象的同名属性,与 _ta_buffer 同法)。
        vm.label("_ta_bytelength_prop");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_tablp_head");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tablp_user");
        vm.label("_tablp_head");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S1, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_tablp_user");
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jeq("_tablp_ab");
        vm.cmpImm(VReg.V1, 0x40);
        vm.jlt("_tablp_user");
        vm.cmpImm(VReg.V1, 0x61);
        vm.jgt("_tablp_user");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_bytelength");
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_tablp_ab");
        vm.load(VReg.RET, VReg.S1, 8);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_tablp_user");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("byteLength"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // ---- _ab_rz_prop(A0=接收者, A1=0 取 maxByteLength / 1 取 resizable)。
        // 静态判不出 ArrayBuffer 的接收者(函数返回的 buffer)走这里;非 buffer 回落
        // 通用具名读,避免劫持用户对象的同名属性。
        for (const [label, kind, key] of [
            ["_ab_maxbytelength_prop_dyn", 0, "maxByteLength"],
            ["_ab_resizable_prop_dyn", 1, "resizable"],
        ]) {
            vm.label(label);
            vm.prologue(16, [VReg.S0, VReg.S1]);
            vm.mov(VReg.S0, VReg.A0);
            vm.shrImm(VReg.V0, VReg.S0, 48);
            vm.cmpImm(VReg.V0, 0x7FFD);
            vm.jeq(label + "_head");
            vm.cmpImm(VReg.V0, 0);
            vm.jne(label + "_user");
            vm.label(label + "_head");
            vm.movImm64(VReg.V1, MASK);
            vm.and(VReg.S1, VReg.S0, VReg.V1);
            vm.movImm64(VReg.V1, vm.ptrFloor);
            vm.cmp(VReg.S1, VReg.V1);
            vm.jlt(label + "_user");
            vm.loadByte(VReg.V1, VReg.S1, 0);
            vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
            vm.jne(label + "_user");
            vm.load(VReg.V2, VReg.S1, 32);       // maxByteLength 字段(-1 = 不可 resize)
            if (kind === 0) {
                vm.cmpImm(VReg.V2, 0);
                vm.jge(label + "_have");
                vm.load(VReg.V2, VReg.S1, 8);    // 不可 resize → byteLength
                vm.label(label + "_have");
                vm.mov(VReg.RET, VReg.V2);
                vm.scvtf(0, VReg.RET);
                vm.fmovToInt(VReg.RET, 0);
            } else {
                vm.cmpImm(VReg.V2, 0);
                vm.jge(label + "_true");
                vm.movImm64(VReg.RET, 0x7ff9000000000000n);
                vm.jmp(label + "_bdone");
                vm.label(label + "_true");
                vm.movImm64(VReg.RET, 0x7ff9000000000001n);
                vm.label(label + "_bdone");
            }
            vm.epilogue([VReg.S0, VReg.S1], 16);
            vm.label(label + "_user");
            vm.mov(VReg.A0, VReg.S0);
            vm.lea(VReg.A1, vm.asm.addString(key));
            vm.movImm64(VReg.V1, 0x7ffc000000000000n);
            vm.or(VReg.A1, VReg.A1, VReg.V1);
            vm.call("_object_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S0);
            vm.call("_maybe_getter");
            vm.epilogue([VReg.S0, VReg.S1], 16);
        }
    }

    // [Design A] _ta_byteoffset(boxed ta) -> byteOffset(裸 int)。
    // 视图:data_ptr@16 - buffer.data_ptr@16。内联(buffer@24==0 或 wrapper 别名自身)→ 0。
    generateTaByteOffset() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_byteoffset");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.load(VReg.V0, VReg.S0, 24);     // buffer;0=内联 → [[ByteOffset]]=0
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tbo_zero");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S1, VReg.V0, VReg.V1); // 裸 buffer
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jne("_tbo_slot");
        vm.load(VReg.V0, VReg.S1, 24);     // owner:wrapper 别名本内联 TA → offset 0
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.cmp(VReg.V0, VReg.S0);
        vm.jeq("_tbo_zero");
        vm.label("_tbo_slot");
        vm.load(VReg.RET, VReg.S0, 32);    // 视图创建时写入的内槽(detach 后仍有效)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_tbo_zero");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _ta_byteoffset_prop(A0=接收者) → 装箱 byteOffset。
        // 编译器 .byteOffset 直调此入口(绕过 prototype getter);detached 须返 0。
        // 非 TA 回落通用具名读(与 _ta_buffer 同法,不劫持用户对象同名属性)。
        vm.label("_ta_byteoffset_prop");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_tbop_head");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tbop_user");
        vm.label("_tbop_head");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S1, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_tbop_user");
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, 0x40);
        vm.jlt("_tbop_user");
        vm.cmpImm(VReg.V1, 0x61);
        vm.jgt("_tbop_user");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_is_detached");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tbop_zero");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_is_oob");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tbop_zero");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_byteoffset");
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_tbop_zero");
        vm.movImm(VReg.RET, 0);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_tbop_user");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("byteOffset"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // [构造器全局值] TypedArray 族 + ArrayBuffer 的运行时构造支持(2026-07-19,test262 TA 区根因:
    // 构造器从未物化为全局值,`ArrayBuffer.prototype.resize` 读 undefined 的属性 → include 加载即抛)。
    // 编译期把构造器标识符物化为 24B 闭包 {magic@0=0xc105, fnptr@8=_ta_ctor_tramp, type@16}
    // (TA=TYPE_*;ArrayBuffer=0x70 伪类型);`new TA(...)` 值路径经 _ta_construct 转发到蹦床,
    // 不走 _fn_construct_call 的实例语义(蹦床直接产 TA/AB 裸指针作 RET)。
    generateCtorSupport() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        const JS_UNDEFINED = 0x7ffb000000000000n;
        const STR_TAG = 0x7ffc000000000000n;
        const AB_PSEUDO = 0x70; // ArrayBuffer 伪类型码(closure@16)

        vm.asm.registerRuntimeString("_str_k_length", "length");
        vm.asm.registerRuntimeString("_str_k_bpe", "BYTES_PER_ELEMENT");

        // ---- _ta_ctor_tramp:闭包 fnptr。约定:S0=闭包块,A0..A4=实参(boxed),_call_argc=个数。
        vm.label("_ta_ctor_tramp");
        vm.prologue(16, [VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.load(VReg.S1, VReg.S0, 16);        // S1 = type(closure@16)
        vm.lea(VReg.V5, "_call_argc");
        vm.load(VReg.S2, VReg.V5, 0);         // S2 = argc
        vm.mov(VReg.S3, VReg.A0);             // S3 = arg0(boxed)
        vm.store(VReg.SP, 0, VReg.A1);        // arg1(options / byteOffset)
        // argc==0 或 arg0===undefined → 空构造
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_tact_len0");
        vm.movImm64(VReg.V0, JS_UNDEFINED);
        vm.cmp(VReg.S3, VReg.V0);
        vm.jeq("_tact_len0");
        // ArrayBuffer 伪类型:new ArrayBuffer(len[, {maxByteLength}])
        vm.cmpImm(VReg.S1, AB_PSEUDO);
        vm.jne("_tact_ta");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_syscall_arg");              // RET = byteLength(裸)
        vm.mov(VReg.S4, VReg.RET);
        vm.cmpImm(VReg.S2, 2);
        vm.jlt("_tact_ab_fixed");
        vm.load(VReg.A0, VReg.SP, 0);         // options
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_tact_ab_fixed");
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_tact_ab_fixed");
        vm.lea(VReg.A1, vm.asm.addString("maxByteLength"));
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_tact_ab_fixed");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_aref_fromindex");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_arraybuffer_new_max");
        vm.jmp("_tact_done");
        vm.label("_tact_ab_fixed");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_arraybuffer_new");
        vm.jmp("_tact_done");
        // ---- TypedArray ----
        vm.label("_tact_ta");
        vm.shrImm(VReg.V0, VReg.S3, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_tact_from");                 // 普通数组 → from(内部逐元素拷贝)
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_tact_obj");                  // boxed 对象 → array-like
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tact_from");                 // 数字等 → from(内部当长度)
        // 裸指针:判别 ArrayBuffer(视图) / TypedArray 源(转换)
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_tact_len0");
        vm.load(VReg.V1, VReg.S3, 0);         // 头 type 字
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jeq("_tact_view");
        vm.cmpImm(VReg.V1, TYPE_INT8_ARRAY);
        vm.jlt("_tact_len0");                 // 非 TA/AB 裸指针 → 宽容空构造
        vm.cmpImm(VReg.V1, TYPE_FLOAT64_ARRAY);
        vm.jgt("_tact_len0");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_ta_to_array");              // TA 源 → 普通数组(0x7FFE)
        vm.mov(VReg.S3, VReg.RET);
        vm.jmp("_tact_from");
        // ---- new TA(buffer[, byteOffset[, length]]) ----
        vm.label("_tact_view");
        vm.movImm(VReg.S4, 0);                // byteOffset 缺省 0
        vm.cmpImm(VReg.S2, 2);
        vm.jlt("_tact_view_len");
        vm.load(VReg.A0, VReg.SP, 0);         // 入口处保存的 arg1(禁信 A1,中间 call 可能打脏)
        vm.call("_syscall_arg");
        vm.mov(VReg.S4, VReg.RET);
        vm.label("_tact_view_len");
        vm.cmpImm(VReg.S2, 3);
        vm.jlt("_tact_view_deflen");
        // 合成派生构造器常把未传实参填成 undefined 仍计 argc≥3;
        // undefined length → 视作未给,走缺省 length-tracking。
        vm.shrImm(VReg.V0, VReg.A2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_tact_view_deflen");
        vm.mov(VReg.A0, VReg.A2);
        vm.call("_syscall_arg");
        vm.mov(VReg.S5, VReg.RET);            // 给定 length(元素数)
        vm.jmp("_tact_view_call");
        vm.label("_tact_view_deflen");        // 缺省 = (byteLength - byteOffset) >> log2(elemSize)
        // 合成派生 ctor 把未传 length 填成 undefined 仍使 argc≥3;此处强制
        // 按「未给 length」登记 length-tracking(否则 resize 后 length 不跟随)。
        vm.movImm(VReg.S2, 2);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_arraybuffer_bytelength");   // 裸 buf 指针 [buf+8]
        vm.sub(VReg.RET, VReg.RET, VReg.S4);
        vm.cmpImm(VReg.S1, TYPE_INT16_ARRAY);
        vm.jeq("_tact_sh1");
        vm.cmpImm(VReg.S1, TYPE_UINT16_ARRAY);
        vm.jeq("_tact_sh1");
        vm.cmpImm(VReg.S1, TYPE_INT32_ARRAY);
        vm.jeq("_tact_sh2");
        vm.cmpImm(VReg.S1, TYPE_UINT32_ARRAY);
        vm.jeq("_tact_sh2");
        vm.cmpImm(VReg.S1, TYPE_FLOAT32_ARRAY);
        vm.jeq("_tact_sh2");
        vm.cmpImm(VReg.S1, TYPE_INT8_ARRAY);
        vm.jeq("_tact_sh0");
        vm.cmpImm(VReg.S1, TYPE_UINT8_ARRAY);
        vm.jeq("_tact_sh0");
        vm.cmpImm(VReg.S1, TYPE_UINT8_CLAMPED_ARRAY);
        vm.jeq("_tact_sh0");
        vm.shrImm(VReg.S5, VReg.RET, 3);
        vm.jmp("_tact_view_call");
        vm.label("_tact_sh0");
        vm.mov(VReg.S5, VReg.RET);
        vm.jmp("_tact_view_call");
        vm.label("_tact_sh1");
        vm.shrImm(VReg.S5, VReg.RET, 1);
        vm.jmp("_tact_view_call");
        vm.label("_tact_sh2");
        vm.shrImm(VReg.S5, VReg.RET, 2);
        vm.label("_tact_view_call");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S4);
        vm.mov(VReg.A3, VReg.S5);
        vm.call("_typed_array_view");
        // argc<3(未显式给 length)= length-tracking 视图 → 登记,resize 后长度跟随。
        // elemSize 由 (byteLength-byteOffset)/length 反推不可靠(长度可能 0),按 type 现算。
        vm.cmpImm(VReg.S2, 3);
        vm.jge("_tact_done");
        vm.mov(VReg.S5, VReg.RET);            // 视图
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_elem_size_of_type");
        vm.mov(VReg.A3, VReg.RET);
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_ta_track_add");
        vm.mov(VReg.RET, VReg.S5);
        vm.jmp("_tact_done");
        // ---- boxed 对象:array-like({length, 0..n-1}) ----
        // [W-23 已测偏差] 曾在此加 @@iterator 优先路(复用 _array_spread_into),
        // 语义上更合规,但 test262 的 makeIterable 工厂内层是 `src[Symbol.iterator]()`
        // ——本运行时对**动态**数组值的 @@iterator 取值/调用返 undefined
        // (`typeof arr[Symbol.iterator] === "undefined"`,见 members/array 层),
        // 于是真去迭代反而在用户回调里抛 "not a function",净损 15 例
        // (它们此前靠"构造出空 TA"侥幸通过 *-not-called-on-empty 之类断言)。
        // 故保留 array-like 路;iterable 支持须先补 @@iterator 的动态取值。
        vm.label("_tact_obj");
        // [buffer view] 装箱 ArrayBuffer 源(new TA(buffer)):头字节判 TYPE_ARRAY_BUFFER
        // → 脱壳走视图构造(此前落 array-like 读 .length=undefined → 空构造,
        // TypedArray at/to* 族的 makeArrayBuffer 工厂用例)。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S3, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_ARRAY_BUFFER);
        vm.jne("_tact_obj_iter");
        vm.mov(VReg.S3, VReg.V0);                  // 裸 buffer
        vm.jmp("_tact_view");
        vm.label("_tact_obj_iter");
        // [iterable] 优先 @@iterator(规范 %TypedArray% 构造器先查迭代协议,后 array-like):
        // `new TA(obj)` 的 obj 是带 Symbol.iterator 的普通对象(makeIterable 工厂)时,
        // 旧实现只读 .length(undefined)→ 宽容空构造 → 长度 0、at(0)=undefined
        // (TypedArray at/to* 族的「Expected SameValue(«undefined», «0»)」)。
        // 键约定:编译器的计算键写点把 Symbol.iterator 归一为字符串键 "Symbol.iterator"
        // (getMemberPropertyName 协议),故此处读也用字符串键(用 symbol raw ptr 读会 miss)。
        vm.mov(VReg.A0, VReg.S3);                  // obj
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");                    // RET = 迭代方法
        vm.mov(VReg.V0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.V0, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);                // 函数?
        vm.jne("_tact_obj_len");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.call("_box_arr_r");                     // RET = 空数组(boxed)
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_spread_into");             // A0=arr,A1=src → RET=arr
        vm.mov(VReg.S3, VReg.RET);
        vm.jmp("_tact_from");
        vm.label("_tact_obj_len");
        vm.lea(VReg.A1, "_str_k_length");
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_object_get");               // RET = obj.length(boxed)
        vm.movImm64(VReg.V2, JS_UNDEFINED);   // (x64 V2==A2 无活值;V0≡RET 会盖掉 length)
        vm.cmp(VReg.RET, VReg.V2);
        vm.jeq("_tact_len0");                 // 无 length(如 iterable 对象)→ 宽容空构造
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_syscall_arg");
        vm.mov(VReg.S4, VReg.RET);            // S4 = len
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_typed_array_new");
        vm.mov(VReg.S5, VReg.RET);            // S5 = ta
        vm.movImm(VReg.S2, 0);                // i(argc 已消费,S2 转作循环变量)
        vm.label("_tact_obj_loop");
        vm.cmp(VReg.S2, VReg.S4);
        vm.jge("_tact_obj_done");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_subscript_get");            // RET = obj[i]
        vm.mov(VReg.A2, VReg.RET);
        vm.mov(VReg.A0, VReg.S5);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_typed_array_set");
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_tact_obj_loop");
        vm.label("_tact_obj_done");
        vm.mov(VReg.RET, VReg.S5);
        vm.jmp("_tact_done");
        // ---- _typed_array_from(type, arg0):数组拷贝 / 数字当长度 ----
        vm.label("_tact_from");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_typed_array_from");
        vm.jmp("_tact_done");
        // ---- 空构造 ----
        vm.label("_tact_len0");
        vm.cmpImm(VReg.S1, AB_PSEUDO);
        vm.jne("_tact_len0_ta");
        vm.movImm(VReg.A0, 0);
        vm.call("_arraybuffer_new");
        vm.jmp("_tact_done");
        vm.label("_tact_len0_ta");
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_typed_array_new");
        vm.label("_tact_done");
        vm.epilogue([VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);

        // ---- _ta_construct(A0=fn 值, A1=实参 boxed 数组) -> RET = 蹦床返回值(原样)。
        vm.label("_ta_construct");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A0);
        vm.store(VReg.SP, 0, VReg.A1);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S3, VReg.S1, VReg.V1);    // S3 = 裸闭包
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);            // S2 = 实参个数
        for (let i = 0; i < 5; i++) {
            const undefL = `_tac_a_undef_${i}`;
            const nextL = `_tac_a_next_${i}`;
            vm.cmpImm(VReg.S2, i);
            vm.jle(undefL);
            vm.load(VReg.A0, VReg.SP, 0);
            vm.movImm(VReg.A1, i);
            vm.call("_array_get");
            vm.store(VReg.SP, 8 + i * 8, VReg.RET);
            vm.jmp(nextL);
            vm.label(undefL);
            vm.movImm64(VReg.V0, JS_UNDEFINED);
            vm.store(VReg.SP, 8 + i * 8, VReg.V0);
            vm.label(nextL);
        }
        vm.load(VReg.A0, VReg.SP, 8);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.load(VReg.A2, VReg.SP, 24);
        vm.load(VReg.A3, VReg.SP, 32);
        vm.load(VReg.A4, VReg.SP, 40);
        vm.lea(VReg.V5, "_call_argc");
        vm.store(VReg.V5, 0, VReg.S2);
        vm.load(VReg.S5, VReg.S3, 8);         // fnptr
        vm.mov(VReg.S0, VReg.S3);             // S0 = 闭包块(调用约定)
        vm.callIndirect(VReg.S5);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        // ---- TA 子类实例原型侧表 ----
        // TypedArray 布局无 __proto__ 槽(+16=data)。`class C extends Int32Array; new C()`
        // 的 [[Prototype]] 须为 C.prototype(OrdinaryCreateFromConstructor)。用链表
        // 侧表 {ta@0, proto@8, next@16} 记录覆盖;查无则回落 _get_ctor_proto 单例。
        vm.asm.addDataLabel("_ta_inst_proto_head");
        vm.asm.addDataQword(0);

        // _ta_bind_instance_proto(A0=ta 值, A1=proto 值) — 裸/装箱皆可
        vm.label("_ta_bind_instance_proto");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // ta raw
        vm.and(VReg.S1, VReg.A1, VReg.V1); // proto raw
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_ta_bip_done");
        // 若已有条目则覆写 proto
        vm.lea(VReg.V0, "_ta_inst_proto_head");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.label("_ta_bip_find");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_ta_bip_new");
        vm.load(VReg.V0, VReg.S2, 0);
        vm.cmp(VReg.V0, VReg.S0);
        vm.jeq("_ta_bip_upd");
        vm.load(VReg.S2, VReg.S2, 16);
        vm.jmp("_ta_bip_find");
        vm.label("_ta_bip_upd");
        vm.store(VReg.S2, 8, VReg.S1);
        vm.jmp("_ta_bip_done");
        vm.label("_ta_bip_new");
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        vm.store(VReg.RET, 0, VReg.S0);
        vm.store(VReg.RET, 8, VReg.S1);
        vm.lea(VReg.V0, "_ta_inst_proto_head");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.RET, 16, VReg.V1);
        vm.store(VReg.V0, 0, VReg.RET);
        vm.label("_ta_bip_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        // _ta_lookup_instance_proto(A0=ta raw) -> RET=proto raw / 0
        vm.label("_ta_lookup_instance_proto");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.V0, "_ta_inst_proto_head");
        vm.load(VReg.S1, VReg.V0, 0);
        vm.label("_ta_lip_loop");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_ta_lip_miss");
        vm.load(VReg.V0, VReg.S1, 0);
        vm.cmp(VReg.V0, VReg.S0);
        vm.jeq("_ta_lip_hit");
        vm.load(VReg.S1, VReg.S1, 16);
        vm.jmp("_ta_lip_loop");
        vm.label("_ta_lip_hit");
        vm.load(VReg.RET, VReg.S1, 8);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_ta_lip_miss");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // ---- _get_ctor_proto(A0=type/pseudo) -> 单例 prototype 对象(boxed)。
        // 槽表:0x40-0x43→0-3,0x50-0x54→4-8,0x60-0x61→9-10,0x70→11。
        vm.asm.addDataLabel("_ctor_proto_tab");
        for (let i = 0; i < 12; i++) vm.asm.addDataQword(0);
        vm.label("_get_ctor_proto");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);             // tag
        vm.cmpImm(VReg.S0, AB_PSEUDO);
        vm.jeq("_gcp_idx_ab");
        vm.mov(VReg.V0, VReg.S0);
        vm.andImm(VReg.V0, VReg.V0, 0xf0);
        vm.cmpImm(VReg.V0, 0x40);
        vm.jeq("_gcp_idx_4x");
        vm.cmpImm(VReg.V0, 0x50);
        vm.jeq("_gcp_idx_5x");
        vm.subImm(VReg.S1, VReg.S0, 0x60 - 9);  // 0x60 族 → 9+
        vm.jmp("_gcp_idx_done");
        vm.label("_gcp_idx_4x");
        vm.subImm(VReg.S1, VReg.S0, 0x40);
        vm.jmp("_gcp_idx_done");
        vm.label("_gcp_idx_5x");
        vm.subImm(VReg.S1, VReg.S0, 0x50 - 4);  // 0x50 族 → 4+
        vm.jmp("_gcp_idx_done");
        vm.label("_gcp_idx_ab");
        vm.movImm(VReg.S1, 11);
        vm.label("_gcp_idx_done");
        vm.lea(VReg.V0, "_ctor_proto_tab");
        vm.shlImm(VReg.V1, VReg.S1, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_gcp_done");
        vm.call("_object_new");
        vm.call("_box_obj_r");                // RET = boxed 对象
        vm.lea(VReg.V2, "_ctor_proto_tab");
        vm.shlImm(VReg.V1, VReg.S1, 3);
        vm.add(VReg.V2, VReg.V2, VReg.V1);
        vm.store(VReg.V2, 0, VReg.RET);       // 缓存单例
        vm.cmpImm(VReg.S0, AB_PSEUDO);
        vm.jne("_gcp_ta_proto");
        // ArrayBuffer.prototype:挂 resize/slice + byteLength/maxByteLength/resizable。
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ab_proto_fill");
        vm.mov(VReg.RET, VReg.S1);
        vm.jmp("_gcp_done");
        vm.label("_gcp_ta_proto");
        vm.mov(VReg.S1, VReg.RET);            // proto(boxed)
        // 链接原型链:Int8Array.prototype.__proto__ = %TypedArray%.prototype
        vm.call("_ta_intrinsic");              // RET = 装箱 %TypedArray%(单例,懒建)
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString("prototype"));
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, STR_TAG); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_closure_prop_get");         // RET = %TypedArray%.prototype(boxed)
        vm.mov(VReg.A1, VReg.RET);            // A1 = %TypedArray%.prototype
        vm.mov(VReg.A0, VReg.S1);             // A0 = boxed 当前 TA proto
        vm.call("_object_setPrototypeOf");
        // BYTES_PER_ELEMENT:1B(0x40/0x50/0x54)→1;2B(0x41/0x51)→2;4B(0x42/0x52/0x60)→4;余→8
        vm.movImm(VReg.A2, 8);
        vm.cmpImm(VReg.S0, TYPE_INT16_ARRAY);
        vm.jeq("_gcp_sz2");
        vm.cmpImm(VReg.S0, TYPE_UINT16_ARRAY);
        vm.jeq("_gcp_sz2");
        vm.cmpImm(VReg.S0, TYPE_INT32_ARRAY);
        vm.jeq("_gcp_sz4");
        vm.cmpImm(VReg.S0, TYPE_UINT32_ARRAY);
        vm.jeq("_gcp_sz4");
        vm.cmpImm(VReg.S0, TYPE_FLOAT32_ARRAY);
        vm.jeq("_gcp_sz4");
        vm.cmpImm(VReg.S0, TYPE_INT8_ARRAY);
        vm.jeq("_gcp_sz1");
        vm.cmpImm(VReg.S0, TYPE_UINT8_ARRAY);
        vm.jeq("_gcp_sz1");
        vm.cmpImm(VReg.S0, TYPE_UINT8_CLAMPED_ARRAY);
        vm.jeq("_gcp_sz1");
        vm.jmp("_gcp_sz_done");
        vm.label("_gcp_sz1");
        vm.movImm(VReg.A2, 1);
        vm.jmp("_gcp_sz_done");
        vm.label("_gcp_sz2");
        vm.movImm(VReg.A2, 2);
        vm.jmp("_gcp_sz_done");
        vm.label("_gcp_sz4");
        vm.movImm(VReg.A2, 4);
        vm.label("_gcp_sz_done");
        vm.scvtf(0, VReg.A2);
        vm.fmovToInt(VReg.A2, 0);             // boxed number
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.A0, VReg.S1, VReg.V1);    // 裸 proto
        vm.lea(VReg.A1, "_str_k_bpe");
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_set");
        // BYTES_PER_ELEMENT 属性描述符:{writable:false, enumerable:false, configurable:false}
        // ATTR_WRITABLE=1, ATTR_ENUMERABLE=2, ATTR_CONFIGURABLE=4 → attr=0=ATTR_NONE 全部置假
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.A0, VReg.S1, VReg.V1);    // 裸 proto
        vm.lea(VReg.A1, "_str_k_bpe");
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 0);                // attr=0
        vm.call("_object_set_prop_attr");
        vm.mov(VReg.RET, VReg.S1);
        vm.label("_gcp_done");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _ta_link_ctor(A0=type, A1=装箱构造器):把 proto.constructor 指回该构造器。
        // 规范 Int8Array.prototype.constructor === Int8Array;此前缺失导致
        // ta.constructor 落到 Object.prototype.constructor,test262 的
        // result.constructor === TA 全判「[Function]≠[Function]」。
        vm.label("_ta_link_ctor");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A1);             // ctor
        vm.call("_get_ctor_proto");           // A0 仍是 type
        vm.mov(VReg.S1, VReg.RET);            // proto
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.A0, VReg.S1, VReg.V1);
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("constructor"));
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, STR_TAG); vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 1 | 4);            // writable|configurable
        vm.call("_object_set_prop_attr");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // ==================== [W-23] %TypedArray% 内在对象 ====================
    // test262 harness/testTypedArray.js 的第一行就是
    //     var TypedArray = Object.getPrototypeOf(Int8Array);
    // 此前返 undefined,于是**凡 include 了该 harness 且引用 TypedArray.prototype 的
    // 用例(本区 74 例)在第一次属性读处即抛 TypeError**,连测试主体都进不去。
    //
    // 这里把 %TypedArray% 物化成真函数值(懒建 + 单例):
    //   fn   = 闭包 {magic@0=0xc105, fnptr@8=_ta_abstract_ctor}(直接调/new 均抛 TypeError,
    //          合 ES「%TypedArray% 是抽象构造器」),侧表挂 .name / .prototype;
    //   原型 = 真普通对象,方法值是 {magic, _aref_generic, _tam_<m>} 闭包 —— 复用既有
    //          方法引用蹦床(接收者 A5 → A0,实参上移),不新造调用约定;
    //   _tam_<m> 先做 ValidateTypedArray(接收者必须是 TA 裸块,否则 TypeError),
    //          再委托既有 _ta_* / _array_*_rt / _agen_* 实现,不复制任何既有算法。
    // 属性位按 ES 内置方法形状:writable|configurable、enumerable:false。
    generateProtoIntrinsic() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        const STR_TAG = 0x7ffc000000000000n;
        const UNDEF = 0x7ffb000000000000n;
        const INT_MAX = 2147483647;
        const ATTR_W_C = 1 | 4; // writable|configurable(enumerable=0)
        const SAVE = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        let uid = 0;
        const L = (t) => `_tam_${t}_${uid++}`;
        const boxStr = (reg) => {
            vm.movImm64(VReg.V1, MASK); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, STR_TAG); vm.or(reg, reg, VReg.V1);
        };
        const keyOf = (reg, name) => { vm.lea(reg, vm.asm.addString(name)); boxStr(reg); };
        const boxIntReg = (reg) => { vm.scvtf(0, reg); vm.fmovToInt(reg, 0); };

        // ---- _tam_validate(A0=接收者) -> RET = 裸 TA 块;非 TA 抛 TypeError(不返回)。
        // 合法接收者是 TA 裸堆指针(high16==0);装箱对象/数组先脱壳再验类型字节,
        // 于是 {} / [] / ArrayBuffer / DataView / 原语 / undefined 一律 TypeError。
        vm.label("_tam_validate");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tam_val_ptr");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_tam_val_ptr");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jne("_tam_val_bad");
        vm.label("_tam_val_ptr");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_tam_val_bad");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, TYPE_INT8_ARRAY);
        vm.jlt("_tam_val_bad");
        vm.cmpImm(VReg.V0, TYPE_FLOAT64_ARRAY);
        vm.jgt("_tam_val_bad");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);
        vm.label("_tam_val_bad");
        vm.lea(VReg.A0, vm.asm.addString("Method %TypedArray%.prototype method called on incompatible receiver"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0], 0);    // 理论不达

        // ---- _ta_abstract_ctor:%TypedArray% 本体不可直接调用/构造。
        vm.label("_ta_abstract_ctor");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.A0, vm.asm.addString("Abstract class TypedArray not directly constructable"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0], 0);    // 理论不达

        // ---- 方法包装器:统一 { 校验接收者 → 委托既有实现 }。
        // 进入约定(来自 _aref_generic):A0=this, A1..A4=实参(装箱,缺参 undefined)。
        // det:"throw"(默认,方法 ValidateTypedArray) / "zero"(访问器 length/byteLength/byteOffset)
        // / "allow"(buffer 访问器,detached 仍返回该 buffer)。
        const wrap = (label, body, det = "throw") => {
            vm.label(label);
            vm.prologue(48, SAVE);
            vm.mov(VReg.S1, VReg.A1);
            vm.mov(VReg.S2, VReg.A2);
            vm.mov(VReg.S3, VReg.A3);
            vm.call("_tam_validate"); // A0 仍是接收者
            vm.mov(VReg.S0, VReg.RET); // S0 = 裸 TA
            if (det === "throw") {
                vm.mov(VReg.A0, VReg.S0);
                vm.call("_tam_throw_if_detached");
            } else if (det === "zero") {
                // length/byteLength/byteOffset:detached 或 OOB → 0
                const z = L("detz");
                const zo = L("zero_out");
                vm.mov(VReg.A0, VReg.S0);
                vm.call("_ta_is_detached");
                vm.cmpImm(VReg.RET, 0);
                vm.jne(zo);
                vm.mov(VReg.A0, VReg.S0);
                vm.call("_ta_is_oob");
                vm.cmpImm(VReg.RET, 0);
                vm.jeq(z);
                vm.label(zo);
                vm.movImm(VReg.RET, 0);
                boxIntReg(VReg.RET);
                vm.epilogue(SAVE, 48);
                vm.label(z);
            }
            body();
            vm.epilogue(SAVE, 48);
        };
        // 装箱实参 → 裸 int(缺省 d)。结果留在 RET。
        const argInt = (src, d) => {
            vm.mov(VReg.A0, src);
            vm.movImm(VReg.A1, d);
            vm.call("_aref_argint_d");
        };
        // 裸 0/1 → JS 布尔
        const boolify = () => {
            const t = L("bt"), d = L("bd");
            vm.cmpImm(VReg.RET, 0);
            vm.jne(t);
            vm.movImm64(VReg.RET, 0x7ff9000000000000n);
            vm.jmp(d);
            vm.label(t);
            vm.movImm64(VReg.RET, 0x7ff9000000000001n);
            vm.label(d);
        };
        // this → 装箱普通数组(留 S4),供 _array_*_rt / _agen_* 复用
        const toArr = () => {
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_ta_to_array");
            vm.mov(VReg.S4, VReg.RET);
        };

        wrap("_tam_at", () => {
            vm.mov(VReg.A0, VReg.S1); vm.call("_aref_argint");
            vm.mov(VReg.S4, VReg.RET);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S4);
            vm.call("_ta_at");
        });
        wrap("_tam_join", () => {
            // 缺参(argc<1)或显式 undefined → ","。aref 缺参时 A1 常为垃圾,勿当 sep。
            const ok = L("jsep");
            const useComma = L("jcomma");
            vm.lea(VReg.V0, "_call_argc");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, 1);
            vm.jlt(useComma);
            vm.mov(VReg.S4, VReg.S1);
            vm.shrImm(VReg.V0, VReg.S1, 48);
            vm.cmpImm(VReg.V0, 0x7FFB);
            vm.jne(ok);
            vm.label(useComma);
            vm.lea(VReg.S4, "_str_comma_only");
            vm.movImm64(VReg.V0, 0x7ffc000000000000n);
            vm.or(VReg.S4, VReg.S4, VReg.V0);
            vm.label(ok);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S4);
            vm.call("_ta_join");
        });
        const joinComma = () => {
            vm.lea(VReg.S4, "_str_comma_only");
            vm.movImm64(VReg.V0, 0x7ffc000000000000n);
            vm.or(VReg.S4, VReg.S4, VReg.V0);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S4);
            vm.call("_ta_join");
        };
        wrap("_tam_toString", joinComma);
        wrap("_tam_toLocaleString", () => {
            // Array.prototype.toLocaleString 算法:Invoke(el, "toLocaleString")
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_ta_to_array");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_agen_toLocaleString");
        });
        wrap("_tam_indexOf", () => {
            // A2 保持装箱 fromIndex;_ta_indexof 内捕获 origLen 后再 ToInteger。
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_indexof");
            boxIntReg(VReg.RET);
        });
        wrap("_tam_lastIndexOf", () => {
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_lastindexof");
            boxIntReg(VReg.RET);
        });
        wrap("_tam_includes", () => {
            argInt(VReg.S2, 0); vm.mov(VReg.A2, VReg.RET);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1);
            vm.call("_ta_includes");
            boolify();
        });
        const sliceLike = () => {
            // 装箱 start/end 交给 _ta_slice(内部先捕 len 再 ToInteger)
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_slice");
        };
        wrap("_tam_slice", sliceLike);
        // [W-32/K7] subarray 是**视图**(共享 buffer),不是拷贝 —— 走 _ta_subarray。
        wrap("_tam_subarray", () => {
            argInt(VReg.S1, 0); vm.mov(VReg.S4, VReg.RET);
            argInt(VReg.S2, INT_MAX); vm.mov(VReg.S5, VReg.RET);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S4); vm.mov(VReg.A2, VReg.S5);
            vm.call("_ta_subarray");
        }, "allow");
        wrap("_tam_fill", () => {
            argInt(VReg.S2, 0); vm.mov(VReg.S4, VReg.RET);
            argInt(VReg.S3, INT_MAX); vm.mov(VReg.S5, VReg.RET);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1);
            vm.mov(VReg.A2, VReg.S4); vm.mov(VReg.A3, VReg.S5);
            vm.call("_ta_fill");
        });
        wrap("_tam_copyWithin", () => {
            argInt(VReg.S1, 0); vm.mov(VReg.S4, VReg.RET);
            argInt(VReg.S2, 0); vm.mov(VReg.S5, VReg.RET);
            argInt(VReg.S3, INT_MAX); vm.mov(VReg.S3, VReg.RET);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S4);
            vm.mov(VReg.A2, VReg.S5); vm.mov(VReg.A3, VReg.S3);
            vm.call("_ta_copywithin");
        });
        wrap("_tam_set", () => {
            // offset 装箱交给 _ta_set(含 -Inf → RangeError);勿先 argInt。
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_set");
        });
        wrap("_tam_reverse", () => { vm.mov(VReg.A0, VReg.S0); vm.call("_ta_reverse"); });
        // [W-32/K7] sort/toSorted 传递比较器(S1);undefined → 数值序,非可调用 → TypeError。
        const sortWith = () => {
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1);
            vm.call("_ta_sort_cmp");
        };
        wrap("_tam_sort", sortWith);
        // [W-32/K7] toReversed/toSorted:TypedArrayCreateSameType(忽略 species),再原地 reverse/sort。
        wrap("_tam_toReversed", () => {
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_ta_clone_same_type");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_ta_reverse");
        });
        wrap("_tam_toSorted", () => {
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_ta_clone_same_type");
            vm.mov(VReg.A0, VReg.RET);
            vm.mov(VReg.A1, VReg.S1);
            vm.call("_ta_sort_cmp");
        });
        wrap("_tam_with", () => {
            // A1=boxed index, A2=boxed value → _ta_with
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_with");
        });
        // TypedArray 迭代器:活读 + OOB→TypeError(耗尽后除外)。禁 toArr 快照。
        const iterKind = (kind) => () => {
            vm.mov(VReg.A0, VReg.S0);
            vm.movImm(VReg.A1, kind);
            vm.call("_ta_iterator_new");
        };
        wrap("_tam_values", iterKind(0));
        wrap("_tam_keys", iterKind(1));
        wrap("_tam_entries", iterKind(2));
        // [W-32/K1] 回调型方法:ES 规定 ValidateTypedArray 之后立刻 IsCallable(callbackfn)。
        const needFn = () => { vm.mov(VReg.A0, VReg.S1); vm.call("_ta_need_fn"); };
        // _ta_forEach / _ta_every / _ta_some(A0=ta, A1=cb, A2=thisArg):
        // 捕 len 后活读;resize/OOB→undefined; [0,len) 恒调回调。供 wrap 与静态编译共用。
        const emitLiveCb2 = (label, kind) => {
            const loop = `_${label}_loop`;
            const done = `_${label}_done`;
            const retL = `_${label}_ret`;
            const falsy = `_${label}_false`;
            const truthy = `_${label}_true`;
            vm.label(label);
            vm.prologue(48, SAVE);
            vm.movImm64(VReg.V1, MASK);
            vm.and(VReg.S0, VReg.A0, VReg.V1);
            vm.mov(VReg.S1, VReg.A1);
            vm.mov(VReg.S2, VReg.A2);
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_ta_need_fn");
            vm.load(VReg.S3, VReg.S0, 8);
            vm.store(VReg.SP, 0, VReg.S3);
            vm.store(VReg.SP, 8, VReg.S1);
            vm.store(VReg.SP, 16, VReg.S2);
            vm.movImm(VReg.S5, 0);
            vm.label(loop);
            vm.load(VReg.S3, VReg.SP, 0);
            vm.cmp(VReg.S5, VReg.S3);
            vm.jge(done);
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S5);
            vm.call("_typed_array_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.scvtf(0, VReg.S5);
            vm.fmovToInt(VReg.A1, 0);
            vm.mov(VReg.A2, VReg.S0);
            vm.load(VReg.A3, VReg.SP, 8);
            vm.load(VReg.A4, VReg.SP, 16);
            vm.call("_aref_invoke_cbt");
            if (kind === 1) {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");
                vm.cmpImm(VReg.RET, 0);
                vm.jeq(falsy);
            } else if (kind === 2) {
                vm.mov(VReg.A0, VReg.RET);
                vm.call("_to_boolean");
                vm.cmpImm(VReg.RET, 0);
                vm.jne(truthy);
            }
            vm.addImm(VReg.S5, VReg.S5, 1);
            vm.jmp(loop);
            if (kind === 1) {
                vm.label(falsy);
                vm.movImm64(VReg.RET, 0x7ff9000000000000n);
                vm.jmp(retL);
                vm.label(done);
                vm.movImm64(VReg.RET, 0x7ff9000000000001n);
                vm.label(retL);
            } else if (kind === 2) {
                vm.label(truthy);
                vm.movImm64(VReg.RET, 0x7ff9000000000001n);
                vm.jmp(retL);
                vm.label(done);
                vm.movImm64(VReg.RET, 0x7ff9000000000000n);
                vm.label(retL);
            } else {
                vm.label(done);
                vm.movImm64(VReg.RET, UNDEF);
            }
            vm.epilogue(SAVE, 48);
        };
        emitLiveCb2("_ta_forEach", 0);
        emitLiveCb2("_ta_every", 1);
        emitLiveCb2("_ta_some", 2);
        wrap("_tam_forEach", () => {
            needFn();
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_forEach");
        });
        wrap("_tam_every", () => {
            needFn();
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_every");
        });
        wrap("_tam_some", () => {
            needFn();
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_some");
        });
        // map:TypedArraySpeciesCreate(O, «len») 在回调循环之前(ES 22.2.3.19)。
        // filter:先跑完全部回调收集 kept,再 SpeciesCreate(O, «captured»)(ES 22.2.3.9)。
        wrap("_tam_map", () => {
            needFn();
            vm.load(VReg.S3, VReg.S0, 8);
            vm.store(VReg.SP, 0, VReg.S3);          // len
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S3);
            vm.call("_ta_species_create_len");
            vm.store(VReg.SP, 8, VReg.RET);         // A
            vm.store(VReg.SP, 16, VReg.S1);         // cb
            vm.store(VReg.SP, 24, VReg.S2);         // thisArg
            vm.movImm(VReg.S5, 0);
            vm.label("_tam_map_loop");
            vm.load(VReg.S3, VReg.SP, 0);
            vm.cmp(VReg.S5, VReg.S3);
            vm.jge("_tam_map_done");
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S5);
            vm.call("_typed_array_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.scvtf(0, VReg.S5);
            vm.fmovToInt(VReg.A1, 0);
            vm.mov(VReg.A2, VReg.S0);
            vm.load(VReg.A3, VReg.SP, 16);
            vm.load(VReg.A4, VReg.SP, 24);
            vm.call("_aref_invoke_cbt");
            vm.mov(VReg.A2, VReg.RET);
            vm.load(VReg.A0, VReg.SP, 8);
            vm.mov(VReg.A1, VReg.S5);
            vm.call("_typed_array_set");
            vm.addImm(VReg.S5, VReg.S5, 1);
            vm.jmp("_tam_map_loop");
            vm.label("_tam_map_done");
            vm.load(VReg.RET, VReg.SP, 8);
        });
        wrap("_tam_filter", () => {
            needFn();
            // 活读收集 kept(禁 toArr 快照):捕 len 后逐下标 Get+回调,命中则 push。
            vm.load(VReg.S3, VReg.S0, 8);
            vm.store(VReg.SP, 0, VReg.S3);          // len
            vm.store(VReg.SP, 16, VReg.S1);         // cb
            vm.store(VReg.SP, 24, VReg.S2);         // thisArg
            vm.movImm(VReg.A0, 0);
            vm.call("_array_new_with_size");
            vm.movImm64(VReg.V1, MASK);
            vm.and(VReg.V0, VReg.RET, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffe000000000000n);
            vm.or(VReg.V0, VReg.V0, VReg.V1);
            vm.store(VReg.SP, 8, VReg.V0);          // kept boxed
            vm.movImm(VReg.S5, 0);                 // i
            vm.label("_tam_filt_loop");
            vm.load(VReg.S3, VReg.SP, 0);
            vm.cmp(VReg.S5, VReg.S3);
            vm.jge("_tam_filt_species");
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S5);
            vm.call("_typed_array_get");
            vm.store(VReg.SP, 32, VReg.RET);       // elem
            vm.mov(VReg.A0, VReg.RET);
            vm.scvtf(0, VReg.S5);
            vm.fmovToInt(VReg.A1, 0);
            vm.mov(VReg.A2, VReg.S0);
            vm.load(VReg.A3, VReg.SP, 16);
            vm.load(VReg.A4, VReg.SP, 24);
            vm.call("_aref_invoke_cbt");
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_to_boolean");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq("_tam_filt_next");
            vm.load(VReg.A0, VReg.SP, 8);
            vm.load(VReg.A1, VReg.SP, 32);
            vm.call("_array_push");
            vm.label("_tam_filt_next");
            vm.addImm(VReg.S5, VReg.S5, 1);
            vm.jmp("_tam_filt_loop");
            vm.label("_tam_filt_species");
            vm.load(VReg.A0, VReg.SP, 8);
            vm.call("_array_length");
            vm.mov(VReg.S4, VReg.RET);             // captured
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S4);
            vm.call("_ta_species_create_len");
            vm.mov(VReg.S5, VReg.RET);             // A
            vm.movImm(VReg.S1, 0);
            vm.label("_tam_filt_copy");
            vm.cmp(VReg.S1, VReg.S4);
            vm.jge("_tam_filt_done");
            vm.load(VReg.A0, VReg.SP, 8);
            vm.mov(VReg.A1, VReg.S1);
            vm.call("_array_get");
            vm.mov(VReg.A2, VReg.RET);
            vm.mov(VReg.A0, VReg.S5);
            vm.mov(VReg.A1, VReg.S1);
            vm.call("_typed_array_set");
            vm.addImm(VReg.S1, VReg.S1, 1);
            vm.jmp("_tam_filt_copy");
            vm.label("_tam_filt_done");
            vm.mov(VReg.RET, VReg.S5);
        });
        const cb3 = (target) => () => {
            needFn();
            toArr();
            vm.mov(VReg.A0, VReg.S4); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call(target);
        };
        // _ta_reduce / _ta_reduceRight:活读(禁 toArr),捕 len 后从左/右折叠。
        const emitLiveReduce = (label, right) => {
            const loop = `_${label}_loop`;
            const done = `_${label}_done`;
            const haveInit = `_${label}_init`;
            vm.label(label);
            vm.prologue(48, SAVE);
            vm.movImm64(VReg.V1, MASK);
            vm.and(VReg.S0, VReg.A0, VReg.V1);
            vm.mov(VReg.S1, VReg.A1); // cb
            vm.mov(VReg.S2, VReg.A2); // init (或 UNDEF)
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_ta_need_fn");
            vm.load(VReg.S3, VReg.S0, 8); // len
            vm.store(VReg.SP, 0, VReg.S3);
            vm.store(VReg.SP, 8, VReg.S1);
            // 有无 initialValue:high16==0x7FFB → 无
            vm.shrImm(VReg.V0, VReg.S2, 48);
            vm.cmpImm(VReg.V0, 0x7FFB);
            vm.jne(haveInit);
            // 无 init:首元素作 acc,从下一索引起
            vm.cmpImm(VReg.S3, 0);
            vm.jeq(`_${label}_empty`);
            if (right) {
                vm.subImm(VReg.S5, VReg.S3, 1);
                vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S5);
                vm.call("_typed_array_get");
                vm.mov(VReg.S4, VReg.RET); // acc
                vm.subImm(VReg.S5, VReg.S5, 1); // k = len-2
            } else {
                vm.movImm(VReg.S5, 0);
                vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S5);
                vm.call("_typed_array_get");
                vm.mov(VReg.S4, VReg.RET);
                vm.movImm(VReg.S5, 1);
            }
            vm.jmp(loop);
            vm.label(haveInit);
            vm.mov(VReg.S4, VReg.S2); // acc = init
            if (right) {
                vm.subImm(VReg.S5, VReg.S3, 1);
            } else {
                vm.movImm(VReg.S5, 0);
            }
            vm.label(loop);
            if (right) {
                vm.cmpImm(VReg.S5, 0);
                vm.jlt(done);
            } else {
                vm.load(VReg.S3, VReg.SP, 0);
                vm.cmp(VReg.S5, VReg.S3);
                vm.jge(done);
            }
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S5);
            vm.call("_typed_array_get");
            // Call(cb, undefined, «acc, val, k, O»)
            // RET≡A0:必须先把元素挪到 A1,再写 A0=acc(同 _array_reduce_rt)。
            vm.mov(VReg.A1, VReg.RET);         // val
            vm.mov(VReg.A0, VReg.S4);          // acc
            vm.scvtf(0, VReg.S5);
            vm.fmovToInt(VReg.A2, 0);         // k
            vm.mov(VReg.A3, VReg.S0);          // O
            vm.load(VReg.A4, VReg.SP, 8);      // cb
            vm.call("_aref_invoke_cb4");
            vm.mov(VReg.S4, VReg.RET);
            if (right) {
                vm.subImm(VReg.S5, VReg.S5, 1);
            } else {
                vm.addImm(VReg.S5, VReg.S5, 1);
            }
            vm.jmp(loop);
            vm.label(done);
            vm.mov(VReg.RET, VReg.S4);
            vm.epilogue(SAVE, 48);
            vm.label(`_${label}_empty`);
            vm.lea(VReg.A0, vm.asm.addString("Reduce of empty TypedArray with no initial value"));
            boxStr(VReg.A0);
            vm.call("_throw_type_error");
            vm.epilogue(SAVE, 48);
        };
        emitLiveReduce("_ta_reduce", false);
        emitLiveReduce("_ta_reduceRight", true);
        wrap("_tam_reduce", () => {
            needFn();
            // argc<2 → init=undefined
            const has2 = L("red_has2");
            vm.lea(VReg.V0, "_call_argc");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, 2);
            vm.jge(has2);
            vm.movImm64(VReg.S2, UNDEF);
            vm.label(has2);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_reduce");
        });
        wrap("_tam_reduceRight", () => {
            needFn();
            const has2 = L("redr_has2");
            vm.lea(VReg.V0, "_call_argc");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, 2);
            vm.jge(has2);
            vm.movImm64(VReg.S2, UNDEF);
            vm.label(has2);
            vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S1); vm.mov(VReg.A2, VReg.S2);
            vm.call("_ta_reduceRight");
        });

        // ---- _tam_find_core(A0=裸/装箱 TA, A1=cb, A2=mode, A3=thisArg) -> 值/下标。
        // mode: bit0 = 返回下标(而非值),bit1 = 反向。
        // 捕 len 后活读 _typed_array_get(resize/OOB→undefined);第三参恒为 TA 自身。
        // 禁 _ta_to_array 快照(否则 mid-iteration shrink 仍喂旧元素)。
        vm.label("_tam_find_core");
        vm.prologue(48, SAVE);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
        vm.mov(VReg.S1, VReg.A1);          // cb
        vm.mov(VReg.S2, VReg.A2);          // mode
        vm.mov(VReg.S3, VReg.A3);          // thisArg
        vm.load(VReg.S4, VReg.S0, 8);      // 捕 len(coerce/resize 前)
        vm.movImm(VReg.S5, 0);
        vm.andImm(VReg.V0, VReg.S2, 2);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tamf_loop");
        vm.subImm(VReg.S5, VReg.S4, 1);
        vm.label("_tamf_loop");
        vm.cmpImm(VReg.S5, 0);
        vm.jlt("_tamf_nf");
        vm.cmp(VReg.S5, VReg.S4);
        vm.jge("_tamf_nf");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_typed_array_get");       // 活读(OOB→undefined)
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.RET);
        vm.scvtf(0, VReg.S5);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S0);          // 第三参 = TA
        vm.mov(VReg.A3, VReg.S1);          // cb
        vm.mov(VReg.A4, VReg.S3);          // thisArg
        vm.call("_aref_invoke_cbt");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tamf_hit");
        vm.andImm(VReg.V0, VReg.S2, 2);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tamf_dec");
        vm.addImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_tamf_loop");
        vm.label("_tamf_dec");
        vm.subImm(VReg.S5, VReg.S5, 1);
        vm.jmp("_tamf_loop");
        vm.label("_tamf_hit");
        vm.andImm(VReg.V0, VReg.S2, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tamf_hit_idx");
        vm.load(VReg.RET, VReg.SP, 0);
        vm.epilogue(SAVE, 48);
        vm.label("_tamf_hit_idx");
        vm.scvtf(0, VReg.S5);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue(SAVE, 48);
        vm.label("_tamf_nf");
        vm.andImm(VReg.V0, VReg.S2, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_tamf_nf_idx");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue(SAVE, 48);
        vm.label("_tamf_nf_idx");
        vm.movImm(VReg.V0, -1);
        vm.scvtf(0, VReg.V0);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue(SAVE, 48);

        const findMode = (mode) => () => {
            needFn();
            vm.mov(VReg.A0, VReg.S0);
            vm.mov(VReg.A1, VReg.S1);
            vm.movImm(VReg.A2, mode);
            vm.mov(VReg.A3, VReg.S2); // thisArg
            vm.call("_tam_find_core");
        };
        wrap("_tam_find", findMode(0));
        wrap("_tam_findIndex", findMode(1));
        wrap("_tam_findLast", findMode(2));
        wrap("_tam_findLastIndex", findMode(3));

        // ---- 访问器 getter(%TypedArray%.prototype 的 buffer/byteLength/byteOffset/length
        // 是访问器而非数据属性;test262 用 gOPD(...).get 取出后 .call(x) 验接收者)。
        // 同样经 _aref_generic 蹦床:_maybe_getter 以 this 在 A0/A5 调用,蹦床把 A5 落到 A0。
        wrap("_tag_buffer", () => { vm.mov(VReg.A0, VReg.S0); vm.call("_ta_buffer"); }, "allow");
        wrap("_tag_byteLength", () => {
            vm.mov(VReg.A0, VReg.S0); vm.call("_ta_bytelength"); boxIntReg(VReg.RET);
        }, "zero");
        wrap("_tag_byteOffset", () => {
            vm.mov(VReg.A0, VReg.S0); vm.call("_ta_byteoffset"); boxIntReg(VReg.RET);
        }, "zero");
        wrap("_tag_length", () => {
            // OOB 固定长度视图:TypedArrayLength → 0(勿返陈旧 length@8)
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_ta_is_oob");
            vm.cmpImm(VReg.RET, 0);
            vm.jeq("_tag_len_live");
            vm.movImm(VReg.RET, 0);
            vm.jmp("_tag_len_box");
            vm.label("_tag_len_live");
            vm.load(VReg.RET, VReg.S0, 8);
            vm.label("_tag_len_box");
            boxIntReg(VReg.RET);
        }, "zero");
        // @@toStringTag getter:ES 规定非 TA 接收者返 undefined(**不抛**),故不走 wrap。
        // detached 不改变 tag。装箱 0x7FFD 与裸指针都认(与 _tam_validate 同法)。
        vm.label("_tag_toStringTag");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tagts_ptr");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_tagts_undef");
        vm.label("_tagts_ptr");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_tagts_undef");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_tagts_undef");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        for (const [tag, nm] of [
            [TYPE_INT8_ARRAY, "Int8Array"], [TYPE_INT16_ARRAY, "Int16Array"],
            [TYPE_INT32_ARRAY, "Int32Array"], [TYPE_INT64_ARRAY, "BigInt64Array"],
            [TYPE_UINT8_ARRAY, "Uint8Array"], [TYPE_UINT16_ARRAY, "Uint16Array"],
            [TYPE_UINT32_ARRAY, "Uint32Array"], [TYPE_UINT64_ARRAY, "BigUint64Array"],
            [TYPE_UINT8_CLAMPED_ARRAY, "Uint8ClampedArray"],
            [TYPE_FLOAT32_ARRAY, "Float32Array"], [TYPE_FLOAT64_ARRAY, "Float64Array"],
        ]) {
            const nx = L("ts");
            vm.cmpImm(VReg.V0, tag);
            vm.jne(nx);
            vm.lea(VReg.RET, vm.asm.addString(nm));
            boxStr(VReg.RET);
            vm.epilogue([VReg.S0], 0);
            vm.label(nx);
        }
        vm.label("_tagts_undef");
        vm.movImm64(VReg.RET, UNDEF);
        vm.epilogue([VReg.S0], 0);

        // ---- TypedArrayCreate(ctor, « len ») ----
        // A0=ctor 值, A1=裸 len, A2=type 字节或 0xFF(自定义构造器)。
        // TA tramp → _typed_array_new;自定义 → Construct([len]) + ValidateTypedArray
        // + 长度守卫。供 %TypedArray%.from/of 共用。
        vm.label("_ta_create_from_ctor");
        vm.prologue(16, SAVE);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.cmpImm(VReg.S2, 0xFF);
        vm.jeq("_tacc_custom");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_typed_array_new");
        vm.epilogue(SAVE, 16);
        vm.label("_tacc_custom");
        vm.movImm(VReg.A0, 1);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S3, VReg.RET);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A2, 0);
        vm.mov(VReg.A0, VReg.S3);
        vm.movImm(VReg.A1, 0);
        vm.call("_array_set");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 0);
        vm.call("_fn_construct_call");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_tam_validate");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_tam_throw_if_detached"); // TypedArrayCreate:ValidateTypedArray 含 detached
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_typed_array_length"); // 活长度(tracking/OOB);禁盲读 +8
        vm.cmp(VReg.RET, VReg.S1);
        vm.jlt("_tacc_short");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue(SAVE, 16);
        vm.label("_tacc_short");
        vm.lea(VReg.A0, vm.asm.addString("TypedArrayCreate: constructed array too short"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");

        // ---- %TypedArray%.from(source[, mapfn[, thisArg]]) ----
        // _aref_generic:A0=this(构造器), A1=source, A2=mapfn, A3=thisArg。
        // 先处理 source(Get length / 迭代)再 TypedArrayCreate:抽象 %TypedArray%
        // 作 this 时 length getter 抛的 Test262Error 必须先于「不可构造」TypeError。
        vm.label("_tam_from");
        vm.prologue(48, SAVE);
        vm.mov(VReg.S0, VReg.A0);             // ctor
        vm.mov(VReg.S1, VReg.A1);             // source
        vm.store(VReg.SP, 0, VReg.A2);        // mapfn
        vm.store(VReg.SP, 8, VReg.A3);        // thisArg
        // mapfn 若非 undefined → IsCallable
        vm.shrImm(VReg.V0, VReg.A2, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_tafrom_nomap");
        vm.cmpImm(VReg.A2, 0);
        vm.jeq("_tafrom_nomap");
        vm.mov(VReg.A0, VReg.A2);
        vm.call("_ta_need_fn");
        vm.label("_tafrom_nomap");
        // 从 ctor 取类型字节:TA tramp → type@16;抽象构造器 → 0;其余 TypeError。
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S2, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jlt("_tafrom_notctor");
        vm.load(VReg.V0, VReg.S2, 0);
        vm.cmpImm(VReg.V0, 0xc105);
        vm.jne("_tafrom_notctor");
        vm.load(VReg.V0, VReg.S2, 8);
        vm.lea(VReg.V1, "_ta_ctor_tramp");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_tafrom_tactor");
        vm.lea(VReg.V1, "_ta_abstract_ctor");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_tafrom_abs");
        vm.lea(VReg.V1, "_aref_generic");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_tafrom_notctor");
        vm.lea(VReg.V1, "_aref_static_tramp");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_tafrom_notctor");
        vm.movImm(VReg.S5, 0xFF);             // 自定义构造器
        vm.jmp("_tafrom_src");
        vm.label("_tafrom_abs");
        vm.movImm(VReg.S5, 0);                // 抽象:先转 source 再抛
        vm.jmp("_tafrom_src");
        vm.label("_tafrom_tactor");
        vm.load(VReg.S5, VReg.S2, 16);        // type
        vm.cmpImm(VReg.S5, 0x70);
        vm.jeq("_tafrom_notctor");
        vm.label("_tafrom_src");
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_tafrom_arr");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_tafrom_obj");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tafrom_raw");
        vm.jmp("_tafrom_arr");                // 原语:走 from_ref(空/ToObject)
        vm.label("_tafrom_raw");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.cmpImm(VReg.V0, 4095);
        vm.jle("_tafrom_arr");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_INT8_ARRAY);
        vm.jlt("_tafrom_obj");                // 可能是装箱脱壳后的普通对象?裸对象少见
        vm.cmpImm(VReg.V1, TYPE_FLOAT64_ARRAY);
        vm.jgt("_tafrom_obj");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_to_array");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_tafrom_arr");
        vm.label("_tafrom_obj");
        // GetMethod(source, @@iterator):well-known 符号 + getter。
        // 只查字符串键会错过 defineProperty(obj, Symbol.iterator) 的访问器,
        // 抽象 %TypedArray%.from 会先抛「不可构造」而不是 getter 的错。
        vm.lea(VReg.A0, "_symwk_iterator");
        vm.lea(VReg.A1, vm.asm.addString("Symbol.iterator"));
        boxStr(VReg.A1);
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.shrImm(VReg.V0, VReg.RET, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_tafrom_arr");                // 可迭代 → from_ref
        // array-like:Get(length) 先于构造
        vm.mov(VReg.A0, VReg.S1);
        keyOf(VReg.A1, "length");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_syscall_arg");              // 裸 len(getter 抛错在此之前)
        vm.mov(VReg.S4, VReg.RET);
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_tafrom_abstract");           // 抽象 ctor:Get length 已发生
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_ta_create_from_ctor");
        vm.mov(VReg.S2, VReg.RET);            // ta
        vm.movImm(VReg.S3, 0);                // i
        vm.label("_tafrom_al_loop");
        vm.cmp(VReg.S3, VReg.S4);
        vm.jge("_tafrom_al_done");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_subscript_get");
        vm.mov(VReg.A2, VReg.RET);            // 元素
        vm.load(VReg.V0, VReg.SP, 0);         // mapfn
        vm.shrImm(VReg.V1, VReg.V0, 48);
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jeq("_tafrom_al_set");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tafrom_al_set");
        vm.mov(VReg.A0, VReg.A2);
        vm.scvtf(0, VReg.S3);
        vm.fmovToInt(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S1);
        vm.mov(VReg.A3, VReg.V0);
        vm.load(VReg.A4, VReg.SP, 8);         // thisArg
        vm.call("_aref_invoke_cbt2");
        vm.mov(VReg.A2, VReg.RET);
        vm.label("_tafrom_al_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_typed_array_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_tafrom_al_loop");
        vm.label("_tafrom_al_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue(SAVE, 48);
        vm.label("_tafrom_arr");
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm64(VReg.A1, UNDEF);          // 先收集元素,mapfn 在 Create 之后
        vm.call("_array_from_ref");
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_tafrom_abstract");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_length");
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_ta_create_from_ctor");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.jmp("_tafrom_al_loop");
        vm.label("_tafrom_abstract");
        vm.lea(VReg.A0, vm.asm.addString("Abstract class TypedArray not directly constructable"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");
        vm.label("_tafrom_notctor");
        vm.lea(VReg.A0, vm.asm.addString("%TypedArray%.from called on non-constructor"));
        boxStr(VReg.A0);
        vm.call("_throw_type_error");

        // ---- %TypedArray%.of(...items) ----
        vm.label("_tam_of");
        vm.prologue(48, SAVE);
        vm.mov(VReg.S0, VReg.A0);             // ctor
        vm.store(VReg.SP, 0, VReg.A1);
        vm.store(VReg.SP, 8, VReg.A2);
        vm.store(VReg.SP, 16, VReg.A3);
        vm.store(VReg.SP, 24, VReg.A4);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.S1, VReg.V0, 0);         // argc(items)
        vm.cmpImm(VReg.S1, 4);
        vm.jle("_taof_argc");
        vm.movImm(VReg.S1, 4);
        vm.label("_taof_argc");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S4, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S4, VReg.V1);
        vm.jlt("_tafrom_notctor");
        vm.load(VReg.V0, VReg.S4, 0);
        vm.cmpImm(VReg.V0, 0xc105);
        vm.jne("_tafrom_notctor");
        vm.load(VReg.V0, VReg.S4, 8);
        vm.lea(VReg.V1, "_ta_ctor_tramp");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_taof_tactor");
        vm.lea(VReg.V1, "_ta_abstract_ctor");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_tafrom_abstract");
        vm.lea(VReg.V1, "_aref_generic");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_tafrom_notctor");
        vm.lea(VReg.V1, "_aref_static_tramp");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_tafrom_notctor");
        vm.movImm(VReg.S5, 0xFF);
        vm.jmp("_taof_create");
        vm.label("_taof_tactor");
        vm.load(VReg.S5, VReg.S4, 16);
        vm.cmpImm(VReg.S5, 0x70);
        vm.jeq("_tafrom_notctor");
        vm.label("_taof_create");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_ta_create_from_ctor");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);
        vm.label("_taof_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_taof_done");
        // 不能 add(V0, SP, i*8):vm.add 不接受 SP(编成 XZR)→ ldr [0] SIGSEGV。
        vm.cmpImm(VReg.S3, 0); vm.jeq("_taof_a0");
        vm.cmpImm(VReg.S3, 1); vm.jeq("_taof_a1");
        vm.cmpImm(VReg.S3, 2); vm.jeq("_taof_a2");
        vm.load(VReg.A2, VReg.SP, 24); vm.jmp("_taof_set");
        vm.label("_taof_a0"); vm.load(VReg.A2, VReg.SP, 0); vm.jmp("_taof_set");
        vm.label("_taof_a1"); vm.load(VReg.A2, VReg.SP, 8); vm.jmp("_taof_set");
        vm.label("_taof_a2"); vm.load(VReg.A2, VReg.SP, 16);
        vm.label("_taof_set");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_typed_array_set");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_taof_loop");
        vm.label("_taof_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue(SAVE, 48);

        // ---- 方法表:[属性名, 规范 length, 包装器标签] ----
        const METHODS = [
            ["at", 1, "_tam_at"], ["copyWithin", 2, "_tam_copyWithin"],
            ["entries", 0, "_tam_entries"], ["every", 1, "_tam_every"],
            ["fill", 1, "_tam_fill"], ["filter", 1, "_tam_filter"],
            ["find", 1, "_tam_find"], ["findIndex", 1, "_tam_findIndex"],
            ["findLast", 1, "_tam_findLast"], ["findLastIndex", 1, "_tam_findLastIndex"],
            ["forEach", 1, "_tam_forEach"], ["includes", 1, "_tam_includes"],
            ["indexOf", 1, "_tam_indexOf"], ["join", 1, "_tam_join"],
            ["keys", 0, "_tam_keys"], ["lastIndexOf", 1, "_tam_lastIndexOf"],
            ["map", 1, "_tam_map"], ["reduce", 1, "_tam_reduce"],
            ["reduceRight", 1, "_tam_reduceRight"], ["reverse", 0, "_tam_reverse"],
            ["set", 1, "_tam_set"], ["slice", 2, "_tam_slice"],
            ["some", 1, "_tam_some"], ["sort", 1, "_tam_sort"],
            ["subarray", 2, "_tam_subarray"], ["toLocaleString", 0, "_tam_toLocaleString"],
            ["toReversed", 0, "_tam_toReversed"], ["toSorted", 1, "_tam_toSorted"],
            ["toString", 0, "_tam_toString"], ["values", 0, "_tam_values"],
            ["with", 2, "_tam_with"],
        ];

        // ---- _ta_intrinsic() -> 装箱 %TypedArray% 函数值(单例)
        vm.asm.addDataLabel("_ta_intrinsic_slot");
        vm.asm.addDataQword(0);
        vm.label("_ta_intrinsic");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);
        vm.lea(VReg.V0, "_ta_intrinsic_slot");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_tapi_done");
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_ta_abstract_ctor");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.mov(VReg.S0, VReg.RET);            // S0 = 装箱 %TypedArray%
        vm.mov(VReg.A0, VReg.S0);
        keyOf(VReg.A1, "name");
        vm.lea(VReg.A2, vm.asm.addString("TypedArray")); boxStr(VReg.A2);
        vm.call("_closure_prop_set");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S1, VReg.RET);            // S1 = 装箱原型对象
        for (const [name, arity, helper] of METHODS) {
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");
            vm.mov(VReg.S2, VReg.RET);
            vm.movImm(VReg.V1, 0xc105);
            vm.store(VReg.S2, 0, VReg.V1);
            vm.lea(VReg.V1, "_aref_generic");
            vm.store(VReg.S2, 8, VReg.V1);
            vm.lea(VReg.V1, helper);
            vm.store(VReg.S2, 16, VReg.V1);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_js_box_function");
            vm.mov(VReg.S2, VReg.RET);        // S2 = 装箱方法
            vm.mov(VReg.A0, VReg.S2);
            keyOf(VReg.A1, "name");
            vm.lea(VReg.A2, vm.asm.addString(name)); boxStr(VReg.A2);
            vm.call("_closure_prop_define");
            vm.mov(VReg.A0, VReg.S2);
            keyOf(VReg.A1, "length");
            vm.movImm(VReg.A2, arity);
            vm.scvtf(0, VReg.A2);
            vm.fmovToInt(VReg.A2, 0);
            // _closure_prop_define(非 _closure_prop_set):闭包元数据 arity(_aref_generic=0)
            // 使 _closure_prop_set 的 length/name 写被「已存在不可写」守卫静默忽略 → 方法
            // .length 恒 0、.name 恒空串(TA find/every 等 name/length 描述符测试判负)。
            // define 语义直覆生效。
            vm.call("_closure_prop_define");
            vm.movImm64(VReg.V1, MASK);
            vm.and(VReg.A0, VReg.S1, VReg.V1); // 裸原型
            keyOf(VReg.A1, name);
            vm.mov(VReg.A2, VReg.S2);
            vm.call("_object_define");
            vm.mov(VReg.A0, VReg.S1);
            keyOf(VReg.A1, name);
            vm.movImm(VReg.A2, ATTR_W_C);
            vm.call("_object_set_prop_attr");
        }
        // @@iterator 与 values 是同一函数(规范 %TypedArray%.prototype[@@iterator] === values)。
        vm.mov(VReg.A0, VReg.S1);
        keyOf(VReg.A1, "values");
        vm.call("_object_get");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.A0, VReg.S1, VReg.V1);
        keyOf(VReg.A1, "Symbol.iterator");
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S1);
        keyOf(VReg.A1, "Symbol.iterator");
        vm.movImm(VReg.A2, ATTR_W_C);
        vm.call("_object_set_prop_attr");
        // 访问器属性:值是 24B TYPE_GETTER 标记块 {60@0, getter@8, setter@16}(裸堆指针),
        // 由既有 _maybe_getter / gOPD 消费。特性位 enumerable:false, configurable:true。
        for (const [name, getter] of [
            ["buffer", "_tag_buffer"], ["byteLength", "_tag_byteLength"],
            ["byteOffset", "_tag_byteOffset"], ["length", "_tag_length"],
            ["Symbol.toStringTag", "_tag_toStringTag"],
        ]) {
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");
            vm.mov(VReg.S2, VReg.RET);         // 裸 getter 闭包
            vm.movImm(VReg.V1, 0xc105);
            vm.store(VReg.S2, 0, VReg.V1);
            vm.lea(VReg.V1, "_aref_generic");
            vm.store(VReg.S2, 8, VReg.V1);
            vm.lea(VReg.V1, getter);
            vm.store(VReg.S2, 16, VReg.V1);
            // 挂 getter 闭包的 .name / .length(闭包属性侧表)
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_js_box_function");       // RET = 装箱 getter(S2 仍是裸指针)
            vm.mov(VReg.S3, VReg.RET);         // S3 = 装箱 getter(跨 _closure_prop_set call 存活)
            vm.mov(VReg.A0, VReg.S3);
            keyOf(VReg.A1, "name");
            {
                // ES 规范:getter 的 name 为 "get <属性名>"
                const gname = name.startsWith("Symbol.") ? name : ("get " + name);
                vm.lea(VReg.A2, vm.asm.addString(gname));
                boxStr(VReg.A2);
            }
            // define:与方法 length 同理——_aref_generic 预置的不可写 name/length
            // 会令 _closure_prop_set 静默 no-op → getter.name 恒空串。
            vm.call("_closure_prop_define");
            vm.mov(VReg.A0, VReg.S3);
            keyOf(VReg.A1, "length");
            vm.movImm(VReg.A2, 0);
            vm.scvtf(0, VReg.A2);
            vm.fmovToInt(VReg.A2, 0);
            vm.call("_closure_prop_define");
            // 现在创建 TYPE_GETTER 标记块,S2 仍是裸 getter 指针
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");                 // RET = 裸标记块
            vm.movImm(VReg.V1, 60);            // TYPE_GETTER
            vm.store(VReg.RET, 0, VReg.V1);
            vm.store(VReg.RET, 8, VReg.S2);    // getter
            vm.movImm(VReg.V1, 0);
            vm.store(VReg.RET, 16, VReg.V1);   // setter = 0
            vm.mov(VReg.S2, VReg.RET);
            vm.movImm64(VReg.V1, MASK);
            vm.and(VReg.A0, VReg.S1, VReg.V1);
            if (name.startsWith("Symbol.")) {
                vm.lea(VReg.A0, "_symwk_" + name.slice("Symbol.".length));
                vm.lea(VReg.A1, vm.asm.addString(name));
                boxStr(VReg.A1);
                vm.call("_symbol_wellknown");
                vm.mov(VReg.A1, VReg.RET);
                vm.movImm64(VReg.V1, MASK);
                vm.and(VReg.A0, VReg.S1, VReg.V1);
            } else {
                keyOf(VReg.A1, name);
            }
            vm.mov(VReg.A2, VReg.S2);
            vm.call("_object_define");
            vm.mov(VReg.A0, VReg.S1);
            if (name.startsWith("Symbol.")) {
                vm.lea(VReg.A0, "_symwk_" + name.slice("Symbol.".length));
                vm.lea(VReg.A1, vm.asm.addString(name));
                boxStr(VReg.A1);
                vm.call("_symbol_wellknown");
                vm.mov(VReg.A1, VReg.RET);
                vm.mov(VReg.A0, VReg.S1);
            } else {
                keyOf(VReg.A1, name);
            }
            vm.movImm(VReg.A2, 4);             // configurable only
            vm.call("_object_set_prop_attr");
        }
        vm.mov(VReg.A0, VReg.S0);
        keyOf(VReg.A1, "prototype");
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_closure_prop_set");
        // prototype 属性描述符:{writable:false, enumerable:false, configurable:false}
        vm.mov(VReg.A0, VReg.S0);
        keyOf(VReg.A1, "prototype");
        vm.movImm(VReg.A2, 0);
        vm.call("_closure_prop_set_attr");
        // %TypedArray%.prototype.constructor = %TypedArray%(规范形状 writable|configurable)
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.A0, VReg.S1, VReg.V1);
        keyOf(VReg.A1, "constructor");
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S1);
        keyOf(VReg.A1, "constructor");
        vm.movImm(VReg.A2, ATTR_W_C);
        vm.call("_object_set_prop_attr");
        // 静态 from/of 挂在 %TypedArray% 函数自身(非 prototype):Int8Array.from 经
        // _closure_prop_get 的 TA 继承回落到这里。
        for (const [name, arity, helper] of [["from", 1, "_tam_from"], ["of", 0, "_tam_of"]]) {
            vm.movImm(VReg.A0, 24);
            vm.call("_alloc");
            vm.mov(VReg.S2, VReg.RET);
            vm.movImm(VReg.V1, 0xc105);
            vm.store(VReg.S2, 0, VReg.V1);
            vm.lea(VReg.V1, "_aref_generic");
            vm.store(VReg.S2, 8, VReg.V1);
            vm.lea(VReg.V1, helper);
            vm.store(VReg.S2, 16, VReg.V1);
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_js_box_function");
            vm.mov(VReg.S2, VReg.RET);
            vm.mov(VReg.A0, VReg.S2);
            keyOf(VReg.A1, "name");
            vm.lea(VReg.A2, vm.asm.addString(name)); boxStr(VReg.A2);
            vm.call("_closure_prop_set");
            vm.mov(VReg.A0, VReg.S2);
            keyOf(VReg.A1, "length");
            vm.movImm(VReg.A2, arity);
            vm.scvtf(0, VReg.A2);
            vm.fmovToInt(VReg.A2, 0);
            vm.call("_closure_prop_define");
            vm.mov(VReg.A0, VReg.S0);
            keyOf(VReg.A1, name);
            vm.mov(VReg.A2, VReg.S2);
            vm.call("_closure_prop_set");
            vm.mov(VReg.A0, VReg.S0);
            keyOf(VReg.A1, name);
            vm.movImm(VReg.A2, ATTR_W_C);
            vm.call("_closure_prop_set_attr");
        }
        vm.lea(VReg.V0, "_ta_intrinsic_slot");
        vm.store(VReg.V0, 0, VReg.S0);
        vm.mov(VReg.RET, VReg.S0);
        vm.label("_tapi_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);

        // ---- _ta_getprototypeof(A0=值) -> Object.getPrototypeOf 语义 + TA 构造器特判。
        // 编译器把 Object.getPrototypeOf 的调用点改派到这里:接收者是 TA 族构造器闭包
        // (fnptr==_ta_ctor_tramp 且 type@16 != ArrayBuffer 伪码)时返 %TypedArray%,
        // 其余原样转发既有 _object_getPrototypeOf(零行为变更)。
        vm.label("_ta_getprototypeof");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        // TA / ArrayBuffer **实例**:[[Prototype]] = 按型 prototype 单例。
        // 此前落通用 _object_getPrototypeOf,TA 块无 proto@16(那是 data_ptr)→ undefined,
        // `Object.getPrototypeOf(new TA()) === TA.prototype` 全败。
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tagp_inst");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_tagp_fn");
        vm.label("_tagp_inst");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S1, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_tagp_fn");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, TYPE_DATA_VIEW);
        vm.jeq("_tagp_dv");
        vm.cmpImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.jeq("_tagp_ab");
        vm.cmpImm(VReg.V0, TYPE_INT8_ARRAY);
        vm.jlt("_tagp_fn");
        vm.cmpImm(VReg.V0, TYPE_FLOAT64_ARRAY);
        vm.jgt("_tagp_fn");
        // 子类 super() 经 _ta_bind_instance_proto 记下 C.prototype;
        // instanceof 已查侧表,此处必须同源,否则 constructor 落按型单例、
        // species slice 不调用户构造器。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_lookup_instance_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_tagp_ta_sing");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_tagp_ta_sing");
        vm.loadByte(VReg.A0, VReg.S1, 0);
        vm.call("_get_ctor_proto");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_tagp_dv");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_ta_lookup_instance_proto");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_tagp_fn");
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_tagp_ab");
        vm.movImm(VReg.A0, 0x70);
        vm.call("_get_ctor_proto");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_tagp_fn");
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jne("_tagp_fwd");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S1, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jlt("_tagp_fwd");
        vm.load(VReg.V0, VReg.S1, 0);
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_tagp_fwd");
        vm.load(VReg.V0, VReg.S1, 8);
        vm.lea(VReg.V1, "_ta_ctor_tramp");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_tagp_fwd");
        vm.load(VReg.V0, VReg.S1, 16);
        vm.cmpImm(VReg.V0, 0x70);             // ArrayBuffer 伪类型不属于 %TypedArray% 族
        vm.jeq("_tagp_fwd");
        vm.call("_ta_intrinsic");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_tagp_fwd");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_getPrototypeOf");
        vm.epilogue([VReg.S0, VReg.S1], 0);

    }
}
