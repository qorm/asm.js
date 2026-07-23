// asm.js 运行时类型常量
// 所有堆分配的复合类型都使用统一的头部结构

// 头部偏移量
export const HEADER_SIZE = 16; // 头部总大小

// 复合类型标记常量 (与 allocator.js 保持一致)
export const TYPE_RAW = 0; // 原始数据
export const TYPE_ARRAY = 1; // 数组
export const TYPE_OBJECT = 2; // 对象
export const TYPE_CLOSURE = 3; // 闘包
export const TYPE_MAP = 4; // Map
export const TYPE_SET = 5; // Set
export const TYPE_STRING = 6; // 字符串
export const TYPE_DATE = 7; // Date
export const TYPE_REGEXP = 8; // RegExp
export const TYPE_GENERATOR = 9; // Generator
export const TYPE_COROUTINE = 10; // Coroutine
export const TYPE_PROMISE = 11; // Promise
export const TYPE_ARRAY_BUFFER = 12; // ArrayBuffer
export const TYPE_NUMBER = 13; // Number (boxed, 默认 float64)
export const TYPE_DATA_VIEW = 14; // DataView [type@0, data_ptr@8, byteOffset@16, byteLength@24]
export const TYPE_SHAPE = 15; // [shape v2] 动态形状转移节点(见 docs/SHAPE_TRANSITIONS_DESIGN.md)
export const TYPE_SHAPE_DESC = 16; // [shape v2 · T2a] 原型带键形状描述符 {@0 count|flags63, @8 keys_ptr}

// TypedArray 类型 (直接作为 type 字段，无需额外 elemType)
// 布局: [type:8 | length:8 | buffer...]
export const TYPE_INT8_ARRAY = 0x40;
export const TYPE_INT16_ARRAY = 0x41;
export const TYPE_INT32_ARRAY = 0x42;
export const TYPE_INT64_ARRAY = 0x43; // BigInt64Array
export const TYPE_UINT8_ARRAY = 0x50;
export const TYPE_UINT16_ARRAY = 0x51;
export const TYPE_UINT32_ARRAY = 0x52;
export const TYPE_UINT64_ARRAY = 0x53; // BigUint64Array
export const TYPE_UINT8_CLAMPED_ARRAY = 0x54;
export const TYPE_FLOAT32_ARRAY = 0x60;
export const TYPE_FLOAT64_ARRAY = 0x61;

// Number 对象结构:
// +0: type (8 bytes) - TYPE_NUMBER | (subtype << 8)
// +8: value (8 bytes) - 数值（float64 位模式或整数）

// ==================== Number 子类型 ====================
// 用于 TypedArray 元素类型标识和显式类型声明

// 有符号整数
export const NUM_INT8 = 0x10; // 1 字节有符号
export const NUM_INT16 = 0x11; // 2 字节有符号
export const NUM_INT32 = 0x12; // 4 字节有符号
export const NUM_INT64 = 0x13; // 8 字节有符号 (默认整数)

// 无符号整数
export const NUM_UINT8 = 0x20; // 1 字节无符号
export const NUM_UINT16 = 0x21; // 2 字节无符号
export const NUM_UINT32 = 0x22; // 4 字节无符号
export const NUM_UINT64 = 0x23; // 8 字节无符号
export const NUM_UINT8_CLAMPED = 0x24; // Uint8ClampedArray 专用

// 浮点数
export const NUM_FLOAT16 = 0x30; // 半精度 (IEEE 754)
export const NUM_FLOAT32 = 0x31; // 单精度 (IEEE 754)
export const NUM_FLOAT64 = 0x32; // 双精度 (IEEE 754, 默认)

// Number 子类型元数据
export const NumberTypes = {
    // 有符号整数
    Int8: { code: NUM_INT8, size: 1, signed: true, float: false },
    Int16: { code: NUM_INT16, size: 2, signed: true, float: false },
    Int32: { code: NUM_INT32, size: 4, signed: true, float: false },
    Int64: { code: NUM_INT64, size: 8, signed: true, float: false },
    // 无符号整数
    Uint8: { code: NUM_UINT8, size: 1, signed: false, float: false },
    Uint16: { code: NUM_UINT16, size: 2, signed: false, float: false },
    Uint32: { code: NUM_UINT32, size: 4, signed: false, float: false },
    Uint64: { code: NUM_UINT64, size: 8, signed: false, float: false },
    // 浮点数
    Float16: { code: NUM_FLOAT16, size: 2, signed: true, float: true },
    Float32: { code: NUM_FLOAT32, size: 4, signed: true, float: true },
    Float64: { code: NUM_FLOAT64, size: 8, signed: true, float: true },
};

// 类型标记位掩码 (用于从 type 字段提取类型)
export const TYPE_MASK = 0xffff;

/**
 * 统一对象头部结构:
 *
 * +0:  type (8 bytes)
 *      - 低 8 位: 类型标记 (TYPE_*)
 *      - 高位: 预留标志位 (GC标记、不可变等)
 *
 * +8:  length (8 bytes)
 *      - 字符串: 字节长度 (不含 null 终止符)
 *      - 数组: 元素数量
 *      - 对象: 属性数量
 *      - Map/Set: 条目数量
 *      - TypedArray: 元素数量
 *
 * +16: content (变长)
 *      - 字符串: UTF-8 字节序列 + null 终止符
 *      - 数组: 元素值数组 (每个 8 字节)
 *      - 对象: 属性对数组 (key:8 + value:8 = 16 字节/对)
 *      - Map: 链表头指针
 *      - Set: 链表头指针
 *      - TypedArray: [element_type: 8B][buffer_ptr: 8B]
 *
 * TypedArray 特殊布局:
 *   +0:  TYPE_TYPED_ARRAY
 *   +8:  length (元素数量)
 *   +16: element_type (NUM_INT8, NUM_FLOAT32 等)
 *   +24: buffer_ptr (指向 ArrayBuffer)
 *
 * ArrayBuffer 布局:
 *   +0:  TYPE_ARRAY_BUFFER
 *   +8:  byte_length
 *   +16: data...
 */
