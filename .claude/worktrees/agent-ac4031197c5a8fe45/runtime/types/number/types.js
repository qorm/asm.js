// asm.js 运行时 - Number 子类型常量定义
//
// Number 对象布局: [type:8 | value:8]
// - type: 类型标识符 (区分不同数值类型)
// - value: 数值存储 (格式取决于类型)

// 有符号整数类型
export const TYPE_INT8 = 20; // 8位有符号整数 [-128, 127]
export const TYPE_INT16 = 21; // 16位有符号整数 [-32768, 32767]
export const TYPE_INT32 = 22; // 32位有符号整数
export const TYPE_INT64 = 23; // 64位有符号整数

// 无符号整数类型
export const TYPE_UINT8 = 24; // 8位无符号整数 [0, 255]
export const TYPE_UINT16 = 25; // 16位无符号整数 [0, 65535]
export const TYPE_UINT32 = 26; // 32位无符号整数
export const TYPE_UINT64 = 27; // 64位无符号整数

// 浮点类型
export const TYPE_FLOAT32 = 28; // IEEE 754 单精度 (32位)
export const TYPE_FLOAT64 = 29; // IEEE 754 双精度 (64位) - 默认

// 类型信息表
export const NumberTypes = {
    // 有符号整数
    int8: {
        id: TYPE_INT8,
        size: 1,
        signed: true,
        min: -128,
        max: 127,
    },
    int16: {
        id: TYPE_INT16,
        size: 2,
        signed: true,
        min: -32768,
        max: 32767,
    },
    int32: {
        id: TYPE_INT32,
        size: 4,
        signed: true,
        min: -2147483648,
        max: 2147483647,
    },
    int64: {
        id: TYPE_INT64,
        size: 8,
        signed: true,
        min: BigInt("-9223372036854775808"),
        max: BigInt("9223372036854775807"),
    },

    // 无符号整数
    uint8: {
        id: TYPE_UINT8,
        size: 1,
        signed: false,
        min: 0,
        max: 255,
    },
    uint16: {
        id: TYPE_UINT16,
        size: 2,
        signed: false,
        min: 0,
        max: 65535,
    },
    uint32: {
        id: TYPE_UINT32,
        size: 4,
        signed: false,
        min: 0,
        max: 4294967295,
    },
    uint64: {
        id: TYPE_UINT64,
        size: 8,
        signed: false,
        min: BigInt(0),
        max: BigInt("18446744073709551615"),
    },

    // 浮点
    float32: {
        id: TYPE_FLOAT32,
        size: 4,
        float: true,
    },
    float64: {
        id: TYPE_FLOAT64,
        size: 8,
        float: true,
    },
};

// 判断类型是否为整数
export function isIntegerType(typeId) {
    return typeId >= TYPE_INT8 && typeId <= TYPE_UINT64;
}

// 判断类型是否为浮点
export function isFloatType(typeId) {
    return typeId === TYPE_FLOAT32 || typeId === TYPE_FLOAT64;
}

