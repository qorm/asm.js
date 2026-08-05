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
import { TYPE_ARRAY_BUFFER, TYPE_DATA_VIEW, TYPE_INT8_ARRAY, TYPE_INT16_ARRAY, TYPE_INT32_ARRAY, TYPE_INT64_ARRAY, TYPE_UINT8_ARRAY, TYPE_UINT16_ARRAY, TYPE_UINT32_ARRAY, TYPE_UINT64_ARRAY, TYPE_UINT8_CLAMPED_ARRAY, TYPE_FLOAT32_ARRAY, TYPE_FLOAT64_ARRAY } from "../../core/types.js";

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
export const ARRAY_BUFFER_HEADER = 32; // [Design B] type@0/byteLength@8/data_ptr@16/owner@24

// ==================== ArrayBuffer ====================

export class ArrayBufferGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
    }

    // [Design B] ArrayBuffer 布局(32B 头):
    //   +0  type (TYPE_ARRAY_BUFFER=12)
    //   +8  byteLength
    //   +16 data_ptr —— 实际字节的地址。own-data buffer = self+32;wrapper(ta.buffer)
    //        = 被别名内存地址(如 ta+16),使 DataView/多视图与源共享同一段内存。
    //   +24 owner —— wrapper 的源对象(GC 根,防其被回收);own-data = 0。
    //   +32.. own-data 内联字节(仅 own-data buffer 用)。
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

        vm.mov(VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0], 16);
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
        vm.movImm(VReg.A0, ARRAY_BUFFER_HEADER); // 仅 32B 头(无 own-data)
        vm.call("_alloc");
        vm.movImm(VReg.V0, TYPE_ARRAY_BUFFER);
        vm.store(VReg.RET, 0, VReg.V0);
        vm.store(VReg.RET, 8, VReg.S1);   // byteLength
        vm.store(VReg.RET, 16, VReg.S0);  // data_ptr = 别名地址
        vm.store(VReg.RET, 24, VReg.S2);  // owner
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // _arraybuffer_bytelength(buf) -> byteLength
    generateByteLength() {
        const vm = this.vm;
        vm.label("_arraybuffer_bytelength");
        vm.load(VReg.RET, VReg.A0, 8);
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

        vm.load(VReg.S0, VReg.A0, 16); // 源 data_ptr
        vm.mov(VReg.S1, VReg.A1);      // start
        vm.mov(VReg.S2, VReg.A2);      // end

        // 新长度 = end - start
        vm.sub(VReg.S3, VReg.S2, VReg.S1);

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
    }

    // ==================== DataView ====================
    // 布局(32B):[type=TYPE_DATA_VIEW(14)@0, data_ptr@8, byteOffset@16, byteLength@24]。
    // data_ptr 取自底层 buffer 的 data_ptr@16 → 与 buffer/源 TypedArray 共享同一内存。

    // _dataview_new(buf, byteOffset, byteLength) -> DataView
    generateDataViewNew() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_dataview_new");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // byteOffset
        vm.mov(VReg.S2, VReg.A2); // byteLength
        // buf.data_ptr@16(buf 高 16=0 裸指针,mask 保险)
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.load(VReg.S3, VReg.V0, 16);
        vm.movImm(VReg.A0, 32);
        vm.call("_alloc");
        vm.movImm(VReg.V0, TYPE_DATA_VIEW);
        vm.store(VReg.RET, 0, VReg.V0);
        vm.store(VReg.RET, 8, VReg.S3);  // data_ptr
        vm.store(VReg.RET, 16, VReg.S1); // byteOffset
        vm.store(VReg.RET, 24, VReg.S2); // byteLength
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _dataview_get(dv, byteOffset, size, flags, le) -> canonical number。
    // flags: bit0=signed, bit1=float。字节按端序汇编(BE 升序 / LE 降序,均 acc=(acc<<8)|b,
    // 免变量移位);再按 size/flags 解释(有符号 sxt、float32 reinterpret、float64 直取位)。
    generateDataViewGet() {
        const vm = this.vm;
        vm.label("_dataview_get");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        // base = dv.data_ptr@8 + dv.byteOffset@16 + byteOffset
        vm.load(VReg.V0, VReg.A0, 8);
        vm.load(VReg.V1, VReg.A0, 16);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
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
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // _dataview_set(dv, byteOffset, value, size, flags, le)。value 为 canonical 数(f64 位)。
    // float 按 size 转 f32/f64 位;整数 fcvtzs 截断。再按端序拆字节写(BE 高位在低地址)。
    generateDataViewSet() {
        const vm = this.vm;
        vm.label("_dataview_set");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.load(VReg.V0, VReg.A0, 8);
        vm.load(VReg.V1, VReg.A0, 16);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.add(VReg.S0, VReg.V0, VReg.A1); // base
        vm.mov(VReg.S1, VReg.A2);          // value(f64 位)
        vm.mov(VReg.S2, VReg.A3);          // size
        vm.mov(VReg.S3, VReg.A4);          // flags
        vm.mov(VReg.S4, VReg.A5);          // le
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
    }

    generate() {
        this.generateNew();
        this.generateWrap();
        this.generateByteLength();
        this.generateDataPtr();
        this.generateSlice();
        this.generateDataViewNew();
        this.generateDataViewGet();
        this.generateDataViewSet();
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
        vm.movImm(VReg.A0, 32);   // 仅 32B 头(无内联数据)
        vm.call("_alloc");
        vm.store(VReg.RET, 0, VReg.S0);   // type
        vm.store(VReg.RET, 8, VReg.S3);   // length
        // data_ptr = buffer.data_ptr@16 + byteOffset
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S1, VReg.V1); // 裸 buffer 指针
        vm.load(VReg.V0, VReg.V0, 16);     // buffer.data_ptr
        vm.add(VReg.V0, VReg.V0, VReg.S2); // + byteOffset
        vm.store(VReg.RET, 16, VReg.V0);   // data_ptr
        vm.store(VReg.RET, 24, VReg.S1);   // buffer(GC 根)
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 16);
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

        // 默认 8 字节 (Float64/Int64/Uint64)：Float64 位模式即 canonical float64，直接返回
        vm.shl(VReg.V1, VReg.S1, 3);
        vm.addImm(VReg.V1, VReg.V1, TYPED_ARRAY_HEADER);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.load(VReg.RET, VReg.V1, 0);
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
        vm.loadByte(VReg.V0, VReg.V1, TYPED_ARRAY_HEADER + 1);
        vm.shl(VReg.V0, VReg.V0, 8);
        vm.or(VReg.RET, VReg.RET, VReg.V0);
        vm.cmpImm(VReg.S2, TYPE_INT16_ARRAY);
        vm.jne("_ta_get_int_to_f64");
        vm.shl(VReg.RET, VReg.RET, 48);                     // Int16 符号扩展
        vm.sar(VReg.RET, VReg.RET, 48);
        vm.jmp("_ta_get_int_to_f64");

        // 4 字节读取 (LE)
        vm.label("_ta_get_word");
        vm.shl(VReg.V1, VReg.S1, 2);                        // index*4
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.RET, VReg.V1, TYPED_ARRAY_HEADER);
        vm.loadByte(VReg.V0, VReg.V1, TYPED_ARRAY_HEADER + 1);
        vm.shl(VReg.V0, VReg.V0, 8); vm.or(VReg.RET, VReg.RET, VReg.V0);
        vm.loadByte(VReg.V0, VReg.V1, TYPED_ARRAY_HEADER + 2);
        vm.shl(VReg.V0, VReg.V0, 16); vm.or(VReg.RET, VReg.RET, VReg.V0);
        vm.loadByte(VReg.V0, VReg.V1, TYPED_ARRAY_HEADER + 3);
        vm.shl(VReg.V0, VReg.V0, 24); vm.or(VReg.RET, VReg.RET, VReg.V0);
        vm.cmpImm(VReg.S2, TYPE_INT32_ARRAY);
        vm.jne("_ta_get_int_to_f64");
        vm.shl(VReg.RET, VReg.RET, 32);                     // Int32 符号扩展
        vm.sar(VReg.RET, VReg.RET, 32);
        // fall through

        // 整数 -> canonical float64
        vm.label("_ta_get_int_to_f64");
        vm.scvtf(0, VReg.RET);       // d0 = (double) RET
        vm.fmovToInt(VReg.RET, 0);   // RET = float64 位模式
        vm.jmp("_ta_get_done");

        // Float32 -> float64
        vm.label("_ta_get_f32");
        vm.shl(VReg.V1, VReg.S1, 2);
        vm.add(VReg.V1, VReg.S0, VReg.V1);
        vm.loadByte(VReg.RET, VReg.V1, TYPED_ARRAY_HEADER);
        vm.loadByte(VReg.V0, VReg.V1, TYPED_ARRAY_HEADER + 1);
        vm.shl(VReg.V0, VReg.V0, 8); vm.or(VReg.RET, VReg.RET, VReg.V0);
        vm.loadByte(VReg.V0, VReg.V1, TYPED_ARRAY_HEADER + 2);
        vm.shl(VReg.V0, VReg.V0, 16); vm.or(VReg.RET, VReg.RET, VReg.V0);
        vm.loadByte(VReg.V0, VReg.V1, TYPED_ARRAY_HEADER + 3);
        vm.shl(VReg.V0, VReg.V0, 24); vm.or(VReg.RET, VReg.RET, VReg.V0);
        vm.fmovToFloatSingle(0, VReg.RET); // 位模式 -> s0 单精度
        vm.fcvts2d(0, 0);                  // f32 -> f64
        vm.fmovToInt(VReg.RET, 0);
        vm.jmp("_ta_get_done");

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

        // 加载数组类型
        vm.load(VReg.S4, VReg.S0, 0);
        vm.andImm(VReg.S4, VReg.S4, 0xff);
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

        vm.label("_ta_set_check_heap");
        // 检查 value 是否是 boxed Number（需要 unbox）
        vm.lea(VReg.V0, "_heap_base");
        vm.load(VReg.S3, VReg.V0, 0); // S3 = heap_base

        vm.cmp(VReg.S2, VReg.S3);
        vm.jlt("_ta_set_raw"); // 小于 heap_base，当作 raw

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

        // 整数类型：将 float64 位模式转换为整数
        vm.fmovToFloat(0, VReg.S2);
        vm.fcvtzs(VReg.S2, 0);
        vm.jmp("_ta_set_raw");

        // Float32Array: 将 float64 转换为 float32 位模式
        vm.label("_ta_set_convert_f32");
        vm.fmovToFloat(0, VReg.S2);
        vm.fcvtd2s(0, 0); // double to single
        vm.fmovToIntSingle(VReg.S2, 0);

        vm.label("_ta_set_raw");
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
        vm.storeByte(VReg.V0, 0, VReg.S2); // byte 0
        vm.shr(VReg.V1, VReg.S2, 8);
        vm.storeByte(VReg.V0, 1, VReg.V1); // byte 1
        vm.shr(VReg.V1, VReg.S2, 16);
        vm.storeByte(VReg.V0, 2, VReg.V1); // byte 2
        vm.shr(VReg.V1, VReg.S2, 24);
        vm.storeByte(VReg.V0, 3, VReg.V1); // byte 3
        // vm.jmp("_ta_set_done"); // fall through

        vm.label("_ta_set_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
    }

    // 获取 TypedArray 长度
    // _typed_array_length(arr) -> length
    generateLength() {
        const vm = this.vm;

        vm.label("_typed_array_length");
        vm.load(VReg.RET, VReg.A0, 8);
        vm.ret();
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
        vm.jne("_taf_len");
        // 数组:len = srcArr.length
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
        vm.load(VReg.S3, VReg.S0, 8);      // len
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
        // _ta_join(ta, sep) -> _array_join(_ta_to_array(ta), sep)
        vm.label("_ta_join");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A1);          // sep
        vm.call("_ta_to_array");           // A0=ta;RET=装箱普通数组
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_array_join");
        vm.epilogue([VReg.S0], 0);
        // _ta_indexof(ta, val) -> 首个 _strict_eq(elem, val) 为真的下标(裸 int),否则 -1。
        // 直接逐元素比:_typed_array_get 返 canonical float,val 可能是 int 表示——_strict_eq
        // 实现 `===` 跨表示数值相等(6.0===6 为真),避 _array_indexOf 的位相等/装箱 Number 双路
        // 都不认 canonical-float 元素 vs int 搜索值的坑。(NaN 永不匹配,合 indexOf 语义。)
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_indexof");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
        vm.load(VReg.S1, VReg.S0, 8);      // len
        vm.mov(VReg.S2, VReg.A1);          // val
        vm.movImm(VReg.S3, 0);             // i
        vm.label("_ta_iof_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_ta_iof_nf");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);   // _js_true 低位=1
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_iof_found");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_iof_loop");
        vm.label("_ta_iof_found");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_ta_iof_nf");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        // _ta_includes(ta, val) -> 裸 1(命中)/0(未命中)。同 _strict_eq 逐元素。
        vm.label("_ta_includes");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.load(VReg.S1, VReg.S0, 8);
        vm.mov(VReg.S2, VReg.A1);
        vm.movImm(VReg.S3, 0);
        vm.label("_ta_inc_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_ta_inc_nf");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_get");
        vm.mov(VReg.A0, VReg.RET); vm.mov(VReg.A1, VReg.S2); vm.call("_strict_eq");
        vm.andImm(VReg.V0, VReg.RET, 1);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ta_inc_found");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_ta_inc_loop");
        vm.label("_ta_inc_found");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_ta_inc_nf");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        // _ta_at(ta, idx) -> _array_at(_ta_to_array(ta), idx)
        vm.label("_ta_at");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A1);          // idx(裸 int)
        vm.call("_ta_to_array");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_array_at");
        vm.epilogue([VReg.S0], 0);
    }

    // _ta_slice(ta, start, end) -> 新 typed array(同类型,拷贝元素;带 start/end 归一)。
    // end=2147483647 表示到末尾。语义:slice 返回同类型 typed array(非 view)。
    generateSlice() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_slice");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
        vm.mov(VReg.S1, VReg.A1);          // start
        vm.mov(VReg.S2, VReg.A2);          // end
        vm.load(VReg.S3, VReg.S0, 8);      // len
        // 归一 start:<0 加 len;夹到 [0,len]
        vm.cmpImm(VReg.S1, 0); vm.jge("_ta_sl_s1"); vm.add(VReg.S1, VReg.S1, VReg.S3); vm.label("_ta_sl_s1");
        vm.cmpImm(VReg.S1, 0); vm.jge("_ta_sl_s2"); vm.movImm(VReg.S1, 0); vm.label("_ta_sl_s2");
        vm.cmp(VReg.S1, VReg.S3); vm.jle("_ta_sl_s3"); vm.mov(VReg.S1, VReg.S3); vm.label("_ta_sl_s3");
        // 归一 end:2147483647 或超界 → len;<0 加 len;夹到 [0,len]
        vm.movImm64(VReg.V0, 2147483647n); vm.cmp(VReg.S2, VReg.V0); vm.jne("_ta_sl_e0"); vm.mov(VReg.S2, VReg.S3); vm.jmp("_ta_sl_edone"); vm.label("_ta_sl_e0");
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_sl_e1"); vm.add(VReg.S2, VReg.S2, VReg.S3); vm.label("_ta_sl_e1");
        vm.cmpImm(VReg.S2, 0); vm.jge("_ta_sl_e2"); vm.movImm(VReg.S2, 0); vm.label("_ta_sl_e2");
        vm.cmp(VReg.S2, VReg.S3); vm.jle("_ta_sl_e3"); vm.mov(VReg.S2, VReg.S3); vm.label("_ta_sl_e3");
        vm.label("_ta_sl_edone");
        // newLen = end - start(<0 → 0),复用 S3
        vm.sub(VReg.S3, VReg.S2, VReg.S1);
        vm.cmpImm(VReg.S3, 0); vm.jge("_ta_sl_l0"); vm.movImm(VReg.S3, 0); vm.label("_ta_sl_l0");
        // type = [ta]&0xff
        vm.load(VReg.V0, VReg.S0, 0); vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.mov(VReg.A0, VReg.V0); vm.mov(VReg.A1, VReg.S3); vm.call("_typed_array_new"); vm.mov(VReg.S4, VReg.RET);
        vm.movImm(VReg.S5, 0);             // i
        vm.label("_ta_sl_loop");
        vm.cmp(VReg.S5, VReg.S3); vm.jge("_ta_sl_done");
        vm.add(VReg.V0, VReg.S1, VReg.S5); // start+i
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.V0); vm.call("_typed_array_get");
        vm.mov(VReg.A2, VReg.RET); vm.mov(VReg.A0, VReg.S4); vm.mov(VReg.A1, VReg.S5); vm.call("_typed_array_set");
        vm.addImm(VReg.S5, VReg.S5, 1); vm.jmp("_ta_sl_loop");
        vm.label("_ta_sl_done");
        vm.mov(VReg.RET, VReg.S4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // _ta_fill(ta, val, start, end) -> ta(原地填充,start/end 归一;end=2147483647=到末尾)。
    generateFill() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_fill");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
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
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
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

    // _ta_set(ta, src, offset) -> undefined。src(装箱普通/typed 数组)逐元素写入 ta[offset+i]
    // (经 _subscript_get 取 src[i]、_typed_array_set 按类型强转存)。
    generateSetMethod() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_set");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1); // 裸 ta
        vm.mov(VReg.S1, VReg.A1);          // src(装箱)
        vm.mov(VReg.S2, VReg.A2);          // offset
        // srcLen = [src&MASK + 8]
        vm.movImm64(VReg.V1, MASK); vm.and(VReg.V0, VReg.S1, VReg.V1);
        vm.load(VReg.S3, VReg.V0, 8);      // srcLen
        vm.movImm(VReg.S4, 0);             // i
        vm.label("_tas_loop");             // 注意:避开 _typed_array_set 的 _ta_set_* 标签(碰撞会毁控制流)
        vm.cmp(VReg.S4, VReg.S3); vm.jge("_tas_done");
        vm.mov(VReg.A0, VReg.S1); vm.mov(VReg.A1, VReg.S4); vm.call("_subscript_get"); // src[i]
        vm.mov(VReg.A2, VReg.RET);
        vm.add(VReg.A1, VReg.S2, VReg.S4); // offset+i
        vm.mov(VReg.A0, VReg.S0); vm.call("_typed_array_set");
        vm.addImm(VReg.S4, VReg.S4, 1); vm.jmp("_tas_loop");
        vm.label("_tas_done");
        vm.lea(VReg.RET, "_js_undefined"); vm.load(VReg.RET, VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 0);
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
    }

    // _ta_bytelength(ta) -> length * elemSize(装箱数字,经 boxIntAsNumber 前的裸 int)。
    generateByteLengthMethod() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_bytelength");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
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

    // _ta_sort(ta) -> ta(原地数值升序插入排序;默认数值序,与数组 sort 的字典序不同——
    // TypedArray.sort 默认按数值)。比较函数暂不支持(记偏差,follow-up)。
    generateSortMethod() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_sort");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S0, VReg.A0, VReg.V1);
        vm.load(VReg.S1, VReg.S0, 8);          // len
        vm.movImm(VReg.S2, 1);                 // i
        vm.label("_ta_sort_outer");
        vm.cmp(VReg.S2, VReg.S1); vm.jge("_ta_sort_done");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S2); vm.call("_typed_array_get"); vm.mov(VReg.S4, VReg.RET); // key
        vm.mov(VReg.S3, VReg.S2);              // j = i
        vm.label("_ta_sort_inner");
        vm.cmpImm(VReg.S3, 0); vm.jle("_ta_sort_place"); // j<=0 → place
        vm.subImm(VReg.A1, VReg.S3, 1);        // A1 = j-1
        vm.mov(VReg.A0, VReg.S0); vm.call("_typed_array_get"); vm.mov(VReg.S5, VReg.RET); // prev = ta[j-1]
        vm.fmovToFloat(0, VReg.S5); vm.fmovToFloat(1, VReg.S4); vm.fcmp(0, 1); // d0=prev, d1=key
        vm.jfle("_ta_sort_place");             // prev <= key → place(稳定)
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.mov(VReg.A2, VReg.S5); vm.call("_typed_array_set"); // ta[j]=prev
        vm.subImm(VReg.S3, VReg.S3, 1); vm.jmp("_ta_sort_inner");
        vm.label("_ta_sort_place");
        vm.mov(VReg.A0, VReg.S0); vm.mov(VReg.A1, VReg.S3); vm.mov(VReg.A2, VReg.S4); vm.call("_typed_array_set"); // ta[j]=key
        vm.addImm(VReg.S2, VReg.S2, 1); vm.jmp("_ta_sort_outer");
        vm.label("_ta_sort_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
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
        this.generateTaBuffer();
        this.generateTaByteOffset();
        this.generateCtorSupport();
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
        vm.mov(VReg.S0, VReg.A0);          // boxed ta
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.S1, VReg.S0, VReg.V1); // S1 = 裸 ta
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
    }

    // [Design A] _ta_byteoffset(boxed ta) -> byteOffset(裸 int)。
    // 视图:data_ptr@16 - buffer.data_ptr@16。内联(buffer@24==0 或 wrapper 别名自身)→ 0。
    generateTaByteOffset() {
        const vm = this.vm;
        const MASK = 0x0000ffffffffffffn;
        vm.label("_ta_byteoffset");
        vm.movImm64(VReg.V1, MASK);
        vm.and(VReg.V2, VReg.A0, VReg.V1); // 裸 ta
        vm.load(VReg.V0, VReg.V2, 24);     // buffer
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_tbo_zero");
        vm.load(VReg.V1, VReg.V2, 16);     // ta.data_ptr
        vm.movImm64(VReg.V2, MASK);
        vm.and(VReg.V0, VReg.V0, VReg.V2); // 裸 buffer
        vm.load(VReg.V0, VReg.V0, 16);     // buffer.data_ptr
        vm.sub(VReg.RET, VReg.V1, VReg.V0);
        vm.ret();
        vm.label("_tbo_zero");
        vm.movImm(VReg.RET, 0);
        vm.ret();
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
        // argc==0 或 arg0===undefined → 空构造
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_tact_len0");
        vm.movImm64(VReg.V0, JS_UNDEFINED);
        vm.cmp(VReg.S3, VReg.V0);
        vm.jeq("_tact_len0");
        // ArrayBuffer 伪类型:长度构造
        vm.cmpImm(VReg.S1, AB_PSEUDO);
        vm.jne("_tact_ta");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_syscall_arg");              // RET = byteLength(裸)
        vm.mov(VReg.A0, VReg.RET);
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
        vm.mov(VReg.A0, VReg.A1);
        vm.call("_syscall_arg");
        vm.mov(VReg.S4, VReg.RET);
        vm.label("_tact_view_len");
        vm.cmpImm(VReg.S2, 3);
        vm.jlt("_tact_view_deflen");
        vm.mov(VReg.A0, VReg.A2);
        vm.call("_syscall_arg");
        vm.mov(VReg.S5, VReg.RET);            // 给定 length(元素数)
        vm.jmp("_tact_view_call");
        vm.label("_tact_view_deflen");        // 缺省 = (byteLength - byteOffset) >> log2(elemSize)
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
        vm.jmp("_tact_done");
        // ---- boxed 对象:array-like({length, 0..n-1}) ----
        vm.label("_tact_obj");
        vm.lea(VReg.A1, "_str_k_length");
        vm.movImm64(VReg.V1, STR_TAG);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_object_get");               // RET = obj.length(boxed)
        vm.movImm64(VReg.V0, JS_UNDEFINED);
        vm.cmp(VReg.RET, VReg.V0);
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
        vm.lea(VReg.V0, "_ctor_proto_tab");
        vm.shlImm(VReg.V1, VReg.S1, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.V0, 0, VReg.RET);       // 缓存单例
        vm.cmpImm(VReg.S0, AB_PSEUDO);
        vm.jeq("_gcp_done");                  // ArrayBuffer.prototype 保持空对象
        vm.mov(VReg.S1, VReg.RET);            // proto(boxed)
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
        vm.mov(VReg.RET, VReg.S1);
        vm.label("_gcp_done");
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }
}
