// asm.js 运行时 - Date 支持
// 实现 JavaScript Date 对象的基本功能

import { VReg } from "../../../vm/index.js";
import { TYPE_STRING } from "../../core/allocator.js";

// Date 对象内存布局:
// +0:  type (8 bytes) = TYPE_DATE (7)
// +8:  timestamp (8 bytes) - 毫秒时间戳

const TYPE_DATE = 7;
const DATE_SIZE = 16;

export class DateGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        const vm = this.vm;
        const platform = vm.platform;
        const arch = vm.arch;

        // Date.now() - 获取当前时间戳（毫秒）
        vm.label("_date_now");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        if (platform === "wasi") {
            // wasi:号名空间 = linux-x64,gettimeofday(96);宿主 shim 写 timeval{sec,usec} 两个 i64
            vm.mov(VReg.A0, VReg.SP);
            vm.movImm(VReg.A1, 0);
            vm.syscall(96);

            vm.load(VReg.S0, VReg.SP, 0); // tv_sec
            vm.load(VReg.S1, VReg.SP, 8); // tv_usec
            vm.movImm(VReg.V1, 1000);
            vm.mul(VReg.S0, VReg.S0, VReg.V1);
            vm.div(VReg.S1, VReg.S1, VReg.V1);
            vm.add(VReg.S0, VReg.S0, VReg.S1);
            vm.scvtf(0, VReg.S0);
            vm.fmovToInt(VReg.RET, 0);
        } else if (arch === "arm64" && platform === "macos") {
            // macOS ARM64: 使用 gettimeofday 系统调用
            // SP 指向 prologue 分配的 64 字节空间的底部
            // 我们使用 SP+0 到 SP+15 作为 timeval 缓冲区
            vm.mov(VReg.A0, VReg.SP); // A0 = SP (timeval buffer)
            vm.movImm(VReg.A1, 0); // A1 = NULL (timezone)
            vm.syscall(116); // gettimeofday

            // 系统调用后，检查返回值 (在 X0/A0/RET 中)
            // gettimeofday 成功返回 0，失败返回 -1

            // 读取 tv_sec (8 bytes at SP+0)
            vm.load(VReg.S0, VReg.SP, 0); // tv_sec (整数)
            // 读取 tv_usec (4 bytes at SP+8)
            vm.load(VReg.S1, VReg.SP, 8); // tv_usec (整数)

            // 转换为毫秒（整数运算避免精度损失）
            // ms = sec * 1000 + usec / 1000
            vm.movImm(VReg.V1, 1000);
            vm.mul(VReg.S0, VReg.S0, VReg.V1); // S0 = sec * 1000
            vm.div(VReg.S1, VReg.S1, VReg.V1); // S1 = usec / 1000
            vm.add(VReg.S0, VReg.S0, VReg.S1); // S0 = 总毫秒数

            // 转换为 IEEE 754 浮点数位模式
            vm.scvtf(0, VReg.S0); // D0 = (double)ms
            vm.fmovToInt(VReg.RET, 0); // X0 = D0 的位模式
        } else if (arch === "arm64" && platform === "linux") {
            // Linux ARM64: 使用 clock_gettime
            vm.movImm(VReg.A0, 0); // CLOCK_REALTIME
            vm.mov(VReg.A1, VReg.SP); // timespec 指针
            vm.syscall(228); // clock_gettime (arm64 linux)

            vm.load(VReg.S0, VReg.SP, 0); // tv_sec
            vm.load(VReg.S1, VReg.SP, 8); // tv_nsec

            // 转换为毫秒（整数运算避免精度损失）
            // ms = sec * 1000 + nsec / 1000000
            vm.movImm(VReg.V1, 1000);
            vm.mul(VReg.S0, VReg.S0, VReg.V1); // S0 = sec * 1000
            vm.movImm(VReg.V1, 1000000);
            vm.div(VReg.S1, VReg.S1, VReg.V1); // S1 = nsec / 1000000
            vm.add(VReg.S0, VReg.S0, VReg.S1); // S0 = 总毫秒数

            // 转换为 IEEE 754 浮点数位模式
            vm.scvtf(0, VReg.S0); // D0 = (double)ms
            vm.fmovToInt(VReg.RET, 0);
        } else if (arch === "x64" && platform === "macos") {
            // macOS x64: 使用 gettimeofday (syscall 116 + 0x2000000)
            // XNU gettimeofday 是三参系统调用:gettimeofday(timeval*, timezone*, uint64_t* mach)。
            // 第三参 A2(RDX) 若非零,内核把 mach_absolute_time 写入 *A2。x64 调用点进入
            // 时 RDX 残留的是刚装箱的属性值/野堆指针 → 内核回写 mach 值把某个已存属性 key
            // 覆写成随机大整数 → 后续属性扫描解引用该野 key 段错误(Rosetta 下自举挂点;
            // 症状为 new Date()/Date.now() 之后设别的属性即崩)。必须显式清零 A2。
            // arm64 分支不清 A2 也不崩:其寄存器分配令 X2 在此处恒为良性值,且已冻结不动。
            vm.mov(VReg.A0, VReg.SP);
            vm.movImm(VReg.A1, 0);
            vm.movImm(VReg.A2, 0); // mach_absolute_time 出参指针置 NULL,禁内核回写野指针
            vm.syscall(0x2000074); // gettimeofday (macOS x64)

            vm.load(VReg.S0, VReg.SP, 0); // tv_sec
            vm.load(VReg.S1, VReg.SP, 8); // tv_usec

            // 转换为毫秒（整数运算避免精度损失）
            vm.movImm(VReg.V1, 1000);
            vm.mul(VReg.S0, VReg.S0, VReg.V1); // S0 = sec * 1000
            vm.div(VReg.S1, VReg.S1, VReg.V1); // S1 = usec / 1000
            vm.add(VReg.S0, VReg.S0, VReg.S1); // S0 = 总毫秒数

            // 转换为 IEEE 754 浮点数位模式
            vm.scvtf(0, VReg.S0); // XMM0 = (double)ms
            vm.fmovToInt(VReg.RET, 0); // RAX = XMM0 的位模式
        } else if (arch === "x64" && platform === "linux") {
            // Linux x64: 使用 gettimeofday
            vm.mov(VReg.A0, VReg.SP);
            vm.movImm(VReg.A1, 0);
            vm.syscall(96); // gettimeofday (linux x64)

            vm.load(VReg.S0, VReg.SP, 0); // tv_sec
            vm.load(VReg.S1, VReg.SP, 8); // tv_usec

            // 转换为毫秒（整数运算避免精度损失）
            vm.movImm(VReg.V1, 1000);
            vm.mul(VReg.S0, VReg.S0, VReg.V1); // S0 = sec * 1000
            vm.div(VReg.S1, VReg.S1, VReg.V1); // S1 = usec / 1000
            vm.add(VReg.S0, VReg.S0, VReg.S1); // S0 = 总毫秒数

            // 转换为 IEEE 754 浮点数位模式
            vm.scvtf(0, VReg.S0); // XMM0 = (double)ms
            vm.fmovToInt(VReg.RET, 0); // RAX = XMM0 的位模式
        } else if (arch === "x64" && platform === "windows") {
            // Windows x64: 使用 GetSystemTimeAsFileTime
            // FILETIME 是 100 纳秒为单位，从 1601-01-01 开始
            // 需要转换为从 1970-01-01 的毫秒数

            // GetSystemTimeAsFileTime 参数: RCX = FILETIME 指针
            vm.mov(VReg.A0, VReg.SP); // RCX = SP (FILETIME buffer, 8 bytes)
            vm.callIAT("GetSystemTimeAsFileTime");

            // 读取 FILETIME (64位值，存储在 SP+0)
            vm.load(VReg.S0, VReg.SP, 0); // 整个 64 位 FILETIME

            // 转换 FILETIME 到 Unix 时间戳（毫秒）
            // FILETIME epoch: 1601-01-01
            // Unix epoch: 1970-01-01
            // 差值: 116444736000000000 (100纳秒单位)

            // 加载 epoch 差值到 S1
            // 116444736000000000 = 0x019DB1DED53E8000
            vm.movImm(VReg.S1, 0x019db1de);
            vm.shlImm(VReg.S1, VReg.S1, 32);
            vm.movImm(VReg.V1, 0xd53e8000);
            vm.or(VReg.S1, VReg.S1, VReg.V1);

            // S0 = FILETIME - epoch_diff
            vm.sub(VReg.S0, VReg.S0, VReg.S1);

            // 转换为毫秒: S0 / 10000 (整数除法)
            vm.movImm(VReg.V1, 10000);
            vm.div(VReg.S0, VReg.S0, VReg.V1); // S0 = 毫秒

            // 转换为 IEEE 754 浮点数位模式
            vm.scvtf(0, VReg.S0); // XMM0 = (double)ms

            vm.fmovToInt(VReg.RET, 0); // RAX = XMM0 的位模式
        } else {
            // 其他平台：返回 0
            vm.movImm(VReg.RET, 0);
        }

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);

        // _date_new_ts - 用给定时间戳(裸 float 位)创建 Date,不做 0→now 特判。
        // new Date(ms) / new Date(y,mo,...) 走此路径,故 new Date(0)/new Date(1970,0,1)
        // 得真正的纪元而非当前时间。
        vm.label("_date_new_ts");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.A0, DATE_SIZE);
        vm.call("_alloc");
        vm.movImm(VReg.V1, TYPE_DATE);
        vm.store(VReg.RET, 0, VReg.V1);
        vm.store(VReg.RET, 8, VReg.S0);
        // [#62] NaN-box 打对象 tag(0x7ffd):裸堆指针高16=0 会被 typeof/容器读回当微小
        //  double → "number";装箱后 typeof=="object"、存入/读出容器 tag 不丢。所有解引用
        //  Date 的 _date_* 运行时(getTime/get_part/set_part)按 0x0000ffffffffffff 脱壳兼容。
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0], 16);

        // _date_new - 创建新的 Date 对象
        // A0 = 时间戳（可选，0 表示使用当前时间）—— 仅无参 new Date() 用此 0→now 语义
        vm.label("_date_new");
        vm.prologue(16, [VReg.S0]);

        vm.mov(VReg.S0, VReg.A0); // 保存时间戳参数

        // 如果时间戳为 0，获取当前时间
        vm.cmpImm(VReg.S0, 0);
        const hasTimestampLabel = "_date_new_has_ts";
        vm.jne(hasTimestampLabel);
        vm.call("_date_now");
        vm.mov(VReg.S0, VReg.RET);
        vm.label(hasTimestampLabel);

        // 分配 Date 对象
        vm.movImm(VReg.A0, DATE_SIZE);
        vm.call("_alloc");

        // 设置类型和时间戳
        vm.movImm(VReg.V1, TYPE_DATE);
        vm.store(VReg.RET, 0, VReg.V1); // type
        vm.store(VReg.RET, 8, VReg.S0); // timestamp
        // [#62] NaN-box 对象 tag(见 _date_new_ts)
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);

        vm.epilogue([VReg.S0], 16);

        // _date_new_from_string - 从 ISO 字符串创建 Date 对象
        // A0 = 字符串指针 (指向字符内容，如 "2026-01-14T08:03:47.577Z")
        vm.label("_date_new_from_string");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0); // 保存字符串指针

        // 解析 ISO 字符串为时间戳
        vm.call("_date_parse_iso");
        vm.mov(VReg.S0, VReg.RET); // S0 = 时间戳

        // 分配 Date 对象
        vm.movImm(VReg.A0, DATE_SIZE);
        vm.call("_alloc");

        // 设置类型和时间戳
        vm.movImm(VReg.V1, TYPE_DATE);
        vm.store(VReg.RET, 0, VReg.V1); // type
        vm.store(VReg.RET, 8, VReg.S0); // timestamp
        // [#62] NaN-box 对象 tag(见 _date_new_ts)
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);

        vm.epilogue([VReg.S0], 16);

        // _date_getTime - 获取 Date 对象的时间戳
        // A0 = Date 值(装箱 0x7ffd 或裸指针)
        vm.label("_date_getTime");
        // [#62] 脱壳:装箱 Date 高16=0x7ffd,直接 load 会解引用被污染地址而崩。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.A0, VReg.V1);
        vm.load(VReg.RET, VReg.A0, 8);
        vm.ret();

        // _date_toString - 返回日期字符串
        // A0 = Date 对象指针
        // 返回: 字符串指针（与 toISOString 相同格式）
        vm.label("_date_toString");
        // 直接调用 toISOString 返回格式化字符串
        vm.jmp("_date_toISOString");

        // 生成 toISOString 相关辅助函数
        this.generateToISOString();
    }

    // 生成 _date_toISOString 函数
    // 返回格式: YYYY-MM-DDTHH:mm:ss.sssZ (24 字符)
    generateToISOString() {
        const vm = this.vm;

        // _date_toISOString
        // A0 = Date 对象指针
        // 返回: 字符串指针
        vm.label("_date_toISOString");
        vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        // 经 _date_get_part 逐字段拆解(UTC 语义,负 ms/1970 前正确;旧浮点分解对负
        // 时间戳产生负字段 → toISOString 输出乱码)。get_part 会破坏 S3-S5,故全部经栈中转。
        // 栈: [0]ms [8]sec [16]min [24]hour [32]strptr [40]date [48]year [56]month(1基) [64]day
        vm.store(VReg.SP, 40, VReg.A0); // boxed date
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 7); vm.call("_date_get_part"); vm.store(VReg.SP, 0, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 5); vm.call("_date_get_part"); vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 4); vm.call("_date_get_part"); vm.store(VReg.SP, 16, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 3); vm.call("_date_get_part"); vm.store(VReg.SP, 24, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 0); vm.call("_date_get_part"); vm.store(VReg.SP, 48, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 1); vm.call("_date_get_part"); vm.addImm(VReg.RET, VReg.RET, 1); vm.store(VReg.SP, 56, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 2); vm.call("_date_get_part"); vm.store(VReg.SP, 64, VReg.RET);

        // 分配字符串: 16字节头部(type+length) + 24字节内容 + 1字节 NUL = 41, 对齐到 48
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        // RET(=RAX/X0) = 字符串指针,先落栈。**必须在 load S3/S4/S5 之前**:x64 上 S5 是内存
        // 槽而非寄存器,`load S5` 以 RAX 作暂存会覆盖 alloc 结果(x64 段错误根因)。
        vm.store(VReg.SP, 32, VReg.RET); // 保存字符串指针到栈

        // 年/月/日装入 S3/S4/S5 供下方 builder(_write_int_padded_* 为叶子,不破坏 S 寄存器)
        vm.load(VReg.S3, VReg.SP, 48); // year
        vm.load(VReg.S4, VReg.SP, 56); // month(1基)
        vm.load(VReg.S5, VReg.SP, 64); // day

        // 重新加载到 S0 (callee-saved, 不会被覆盖)
        vm.load(VReg.S0, VReg.SP, 32);

        // 设置字符串头: [type=6][length=24]
        // 只改最低字节写 type，保留高位 size/class 与 bit15(mark)（GC sweep 靠 size 走块）
        vm.load(VReg.V0, VReg.S0, 0);
        vm.movImm64(VReg.V1, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V1, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.S0, 0, VReg.V0);
        vm.movImm(VReg.V0, 24); // 字符串长度
        vm.store(VReg.S0, 8, VReg.V0);

        // 内容从 offset 16 开始
        // 格式: YYYY-MM-DDTHH:mm:ss.sssZ

        // 写入年 (4位) 到 [RET+16..RET+19]
        vm.load(VReg.S0, VReg.SP, 32); // 重新加载字符串指针
        vm.addImm(VReg.S0, VReg.S0, 16); // S0 = 内容起始地址
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3); // year
        vm.call("_write_int_padded_4");

        // 写入 '-' 到 [RET+20]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.movImm(VReg.V0, 45); // '-'
        vm.storeByte(VReg.S0, 20, VReg.V0);

        // 写入月 (2位) 到 [RET+21..RET+22]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.addImm(VReg.V1, VReg.S0, 21);
        vm.mov(VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.S4); // month
        vm.call("_write_int_padded_2");

        // 写入 '-' 到 [RET+23]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.movImm(VReg.V0, 45);
        vm.storeByte(VReg.S0, 23, VReg.V0);

        // 写入日 (2位) 到 [RET+24..RET+25]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.addImm(VReg.V1, VReg.S0, 24);
        vm.mov(VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.S5); // day
        vm.call("_write_int_padded_2");

        // 写入 'T' 到 [RET+26]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.movImm(VReg.V0, 84); // 'T'
        vm.storeByte(VReg.S0, 26, VReg.V0);

        // 写入时 (2位) 到 [RET+27..RET+28]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.addImm(VReg.V1, VReg.S0, 27);
        vm.mov(VReg.A0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 24); // 时
        vm.call("_write_int_padded_2");

        // 写入 ':' 到 [RET+29]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.movImm(VReg.V0, 58); // ':'
        vm.storeByte(VReg.S0, 29, VReg.V0);

        // 写入分 (2位) 到 [RET+30..RET+31]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.addImm(VReg.V1, VReg.S0, 30);
        vm.mov(VReg.A0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 16); // 分
        vm.call("_write_int_padded_2");

        // 写入 ':' 到 [RET+32]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.movImm(VReg.V0, 58);
        vm.storeByte(VReg.S0, 32, VReg.V0);

        // 写入秒 (2位) 到 [RET+33..RET+34]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.addImm(VReg.V1, VReg.S0, 33);
        vm.mov(VReg.A0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 8); // 秒
        vm.call("_write_int_padded_2");

        // 写入 '.' 到 [RET+35]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.movImm(VReg.V0, 46); // '.'
        vm.storeByte(VReg.S0, 35, VReg.V0);

        // 写入毫秒 (3位) 到 [RET+36..RET+38]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.addImm(VReg.V1, VReg.S0, 36);
        vm.mov(VReg.A0, VReg.V1);
        vm.load(VReg.A1, VReg.SP, 0); // 毫秒
        vm.call("_write_int_padded_3");

        // 写入 'Z' 到 [RET+39]
        vm.load(VReg.S0, VReg.SP, 32);
        vm.movImm(VReg.V0, 90); // 'Z'
        vm.storeByte(VReg.S0, 39, VReg.V0);

        // 写入 NUL 到 [RET+40]
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S0, 40, VReg.V0);

        // 返回标准字符串值 = content 指针 (block+16),与 _strconcat/_getStrContent 一致。
        // (旧实现返回 block 指针,仅 _print_value_heap_date 特判 +16,令 d.toISOString()
        //  作真字符串使用/解析/拼接时全部错位 16 字节;现统一为 user_ptr。)
        // [#55] 必须 NaN-box 打字符串 tag(0x7FFC):裸指针高16=0 被 typeof/String()/+
        //  当作微小 double(塌成 "0.");index/length 走裸指针兼容路径才看似正常。
        //  与 _strconcat/_str_slice 尾部一致:content_ptr & 0x0000ffffffffffff | 0x7ffc...
        vm.load(VReg.RET, VReg.SP, 32);
        vm.addImm(VReg.RET, VReg.RET, 16);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        // 辅助函数
        this.generateDaysToYMD();
        this.generateWritePadded(); // 新的写入函数，不打印
        this.generateParseISO(); // ISO 字符串解析
    }

    // 打印单个字符 (保留给其他地方使用)
    printChar(charCode) {
        const vm = this.vm;
        vm.movImm(VReg.V1, charCode);
        vm.push(VReg.V1);
        vm.movImm(VReg.A0, 1);
        vm.mov(VReg.A1, VReg.SP);
        vm.movImm(VReg.A2, 1);
        this.emitWriteCall();
        vm.pop(VReg.V1);
    }

    // 天数转年月日 (简化版 - 使用循环)
    // A0 = 从 1970-01-01 的天数
    // 返回: RET = year * 10000 + month * 100 + day
    generateDaysToYMD() {
        const vm = this.vm;

        // [#35] _date_get_part(A0=boxed date, A1=part) -> 原始整数
        // part: 0=year 1=month(0基) 2=day 3=hours 4=minutes 5=seconds 6=day-of-week
        // UTC 语义;仅支持 ms>=0(1970 起,days_to_ymd 正向循环的既有边界)
        vm.label("_date_get_part");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A1); // part
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // 裸 date 指针
        vm.load(VReg.V0, VReg.S0, 8); // ts(float64 位)
        vm.fmovToFloat(0, VReg.V0);
        vm.fcvtzs(VReg.S0, 0); // S0 = ms 整数
        // part 7 = milliseconds: ms mod 1000(负 ms 修正为 [0,1000))
        vm.cmpImm(VReg.S1, 7);
        vm.jeq("_dgp_ms");
        vm.cmpImm(VReg.S1, 3);
        vm.jge("_dgp_time");
        vm.cmpImm(VReg.S1, 6);
        vm.jeq("_dgp_dow");
        // 历法部件:days = floor(ms/86400000)(负 ms 截断除需 -1 修正)
        vm.movImm(VReg.V1, 86400000);
        vm.div(VReg.A0, VReg.S0, VReg.V1);
        vm.mod(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_dgp_days_ok");
        vm.subImm(VReg.A0, VReg.A0, 1);
        vm.label("_dgp_days_ok");
        vm.call("_date_days_to_ymd"); // RET = y*10000+m*100+d
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_dgp_notyear");
        vm.movImm(VReg.V1, 10000);
        vm.div(VReg.RET, VReg.S2, VReg.V1); // year
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_notyear");
        vm.cmpImm(VReg.S1, 1);
        vm.jne("_dgp_day");
        vm.movImm(VReg.V1, 100);
        vm.div(VReg.V0, VReg.S2, VReg.V1); // y*100+m
        vm.movImm(VReg.V1, 100);
        vm.mod(VReg.RET, VReg.V0, VReg.V1); // m(1基)
        vm.subImm(VReg.RET, VReg.RET, 1);   // 0 基
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_day");
        vm.movImm(VReg.V1, 100);
        vm.mod(VReg.RET, VReg.S2, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_dow");
        // 1970-01-01 是周四(4):dow = (days+4)%7
        vm.movImm(VReg.V1, 86400000);
        vm.div(VReg.V0, VReg.S0, VReg.V1);
        vm.addImm(VReg.V0, VReg.V0, 4);
        vm.movImm(VReg.V1, 7);
        vm.mod(VReg.RET, VReg.V0, VReg.V1);
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_dgp_dow_ok");
        vm.addImm(VReg.RET, VReg.RET, 7);
        vm.label("_dgp_dow_ok");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_ms");
        vm.movImm(VReg.V1, 1000);
        vm.mod(VReg.RET, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_dgp_ms_ok");
        vm.addImm(VReg.RET, VReg.RET, 1000);
        vm.label("_dgp_ms_ok");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_time");
        // msofday = ms mod 86400000,flo底为 [0,86400000)。所有时间字段从此非负量
        // 截断除法取出(旧实现直接对负 ms 截断除 → hours/min 少算 1,pre-1970 乱)。
        vm.movImm(VReg.V1, 86400000);
        vm.mod(VReg.S2, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.S2, 0);
        vm.jge("_dgp_tod_ok");
        vm.addImm(VReg.S2, VReg.S2, 86400000);
        vm.label("_dgp_tod_ok");
        vm.cmpImm(VReg.S1, 4);
        vm.jeq("_dgp_min");
        vm.cmpImm(VReg.S1, 5);
        vm.jeq("_dgp_sec");
        vm.cmpImm(VReg.S1, 6);
        vm.jeq("_dgp_dow");
        // hours = msofday / 3600000  (∈ [0,23])
        vm.movImm(VReg.V1, 3600000);
        vm.div(VReg.RET, VReg.S2, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_min");
        vm.movImm(VReg.V1, 60000);
        vm.div(VReg.V0, VReg.S2, VReg.V1);
        vm.movImm(VReg.V1, 60);
        vm.mod(VReg.RET, VReg.V0, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_sec");
        vm.movImm(VReg.V1, 1000);
        vm.div(VReg.V0, VReg.S2, VReg.V1);
        vm.movImm(VReg.V1, 60);
        vm.mod(VReg.RET, VReg.V0, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        vm.label("_date_days_to_ymd");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        // S0 = 剩余天数 (从 1970-01-01)
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.S1, 1970); // S1 = 年份

        // [#35] 负天数(1970 前):逐年回退直至非负,正向循环即可接手
        vm.label("_date_ymd_neg_loop");
        vm.cmpImm(VReg.S0, 0);
        vm.jge("_date_ymd_neg_done");
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_date_year_days");
        vm.add(VReg.S0, VReg.S0, VReg.RET);
        vm.jmp("_date_ymd_neg_loop");
        vm.label("_date_ymd_neg_done");

        // 年循环 - 每次检查当前年份的天数
        const yearLoop = "_date_ymd_year_loop";
        const yearDone = "_date_ymd_year_done";

        vm.label(yearLoop);
        // 计算当前年份的天数 (365 或 366)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_date_year_days");
        vm.mov(VReg.S2, VReg.RET); // S2 = 该年天数

        // 如果剩余天数 < 该年天数，跳出循环
        vm.cmp(VReg.S0, VReg.S2);
        vm.jlt(yearDone);

        // 减去该年天数，年份加 1
        vm.sub(VReg.S0, VReg.S0, VReg.S2);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp(yearLoop);

        vm.label(yearDone);
        // S0 = 年内第几天 (0-based), S1 = 年份

        // 月循环
        vm.movImm(VReg.S2, 1); // S2 = 月份 (1-12)

        const monthLoop = "_date_ymd_month_loop";
        const monthDone = "_date_ymd_month_done";

        vm.label(monthLoop);
        vm.mov(VReg.A0, VReg.S1); // year
        vm.mov(VReg.A1, VReg.S2); // month
        vm.call("_date_month_days");
        vm.mov(VReg.S3, VReg.RET); // S3 = 该月天数

        vm.cmp(VReg.S0, VReg.S3);
        vm.jlt(monthDone);
        vm.sub(VReg.S0, VReg.S0, VReg.S3);
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp(monthLoop);

        vm.label(monthDone);

        // S0 = day-1, S1 = year, S2 = month
        vm.addImm(VReg.S0, VReg.S0, 1); // day (1-based)

        // 编码返回值: year * 10000 + month * 100 + day
        // 使用 V2 作为临时，避免 V0/RET 同寄存器问题
        vm.movImm(VReg.V2, 10000);
        vm.mul(VReg.RET, VReg.S1, VReg.V2);
        vm.movImm(VReg.V2, 100);
        vm.mul(VReg.V1, VReg.S2, VReg.V2);
        vm.add(VReg.RET, VReg.RET, VReg.V1);
        vm.add(VReg.RET, VReg.RET, VReg.S0);

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _date_year_days: A0 = year, 返回该年天数 (365 或 366)
        // 注意：A0 = V0 = X0，所以必须先保存参数
        vm.label("_date_year_days");
        vm.mov(VReg.V2, VReg.A0); // 保存 year 到 V2，因为 V0 = A0 = X0

        // 简化闰年判断
        vm.movImm(VReg.V0, 400);
        vm.mod(VReg.V1, VReg.V2, VReg.V0); // 用 V2 (year) 而不是 A0
        vm.cmpImm(VReg.V1, 0);
        const yd_not400 = "_date_yd_not400";
        vm.jne(yd_not400);
        vm.movImm(VReg.RET, 366);
        vm.ret();

        vm.label(yd_not400);
        vm.movImm(VReg.V0, 100);
        vm.mod(VReg.V1, VReg.V2, VReg.V0); // 用 V2 (year)
        vm.cmpImm(VReg.V1, 0);
        const yd_not100 = "_date_yd_not100";
        vm.jne(yd_not100);
        vm.movImm(VReg.RET, 365);
        vm.ret();

        vm.label(yd_not100);
        vm.movImm(VReg.V0, 4);
        vm.mod(VReg.V1, VReg.V2, VReg.V0); // 用 V2 (year)
        vm.cmpImm(VReg.V1, 0);
        const yd_not4 = "_date_yd_not4";
        vm.jne(yd_not4);
        vm.movImm(VReg.RET, 366);
        vm.ret();

        vm.label(yd_not4);
        vm.movImm(VReg.RET, 365);
        vm.ret();

        // _date_month_days: A0 = year, A1 = month, 返回该月天数
        vm.label("_date_month_days");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // 保存 year
        vm.mov(VReg.S1, VReg.A1); // 保存 month

        // 二月特殊处理
        vm.cmpImm(VReg.S1, 2);
        const md_not_feb = "_date_md_not_feb";
        vm.jne(md_not_feb);

        // 二月: 判断闰年
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_date_year_days");
        vm.cmpImm(VReg.RET, 366);
        const md_feb_not_leap = "_date_md_feb_not_leap";
        vm.jne(md_feb_not_leap);
        vm.movImm(VReg.RET, 29);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label(md_feb_not_leap);
        vm.movImm(VReg.RET, 28);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label(md_not_feb);
        // 4,6,9,11 月 30 天
        vm.cmpImm(VReg.S1, 4);
        const md_not_30_4 = "_date_md_not_30_4";
        vm.jne(md_not_30_4);
        vm.movImm(VReg.RET, 30);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label(md_not_30_4);
        vm.cmpImm(VReg.S1, 6);
        const md_not_30_6 = "_date_md_not_30_6";
        vm.jne(md_not_30_6);
        vm.movImm(VReg.RET, 30);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label(md_not_30_6);
        vm.cmpImm(VReg.S1, 9);
        const md_not_30_9 = "_date_md_not_30_9";
        vm.jne(md_not_30_9);
        vm.movImm(VReg.RET, 30);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label(md_not_30_9);
        vm.cmpImm(VReg.S1, 11);
        const md_not_30_11 = "_date_md_not_30_11";
        vm.jne(md_not_30_11);
        vm.movImm(VReg.RET, 30);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label(md_not_30_11);
        // 其他月 31 天
        vm.movImm(VReg.RET, 31);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // 写入到内存的带前导零辅助函数 (不打印)
    // A0 = 目标地址, A1 = 数值
    // 注意: A0=X0, A1=X1, V0=X0, V1=X1, 所以必须使用 V3, V4, V5 等不冲突的寄存器
    generateWritePadded() {
        const vm = this.vm;

        // 写入 4 位数字 (年份) 到内存
        // A0 = 目标地址, A1 = 数值
        vm.label("_write_int_padded_4");
        // 叶子函数，使用 V3-V5 避免覆盖 A0/A1

        // 千位
        vm.movImm(VReg.V3, 1000);
        vm.div(VReg.V4, VReg.A1, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48); // +'0'
        vm.storeByte(VReg.A0, 0, VReg.V4);

        // 百位
        vm.mod(VReg.V5, VReg.A1, VReg.V3);
        vm.movImm(VReg.V3, 100);
        vm.div(VReg.V4, VReg.V5, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.storeByte(VReg.A0, 1, VReg.V4);

        // 十位
        vm.mod(VReg.V5, VReg.V5, VReg.V3);
        vm.movImm(VReg.V3, 10);
        vm.div(VReg.V4, VReg.V5, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.storeByte(VReg.A0, 2, VReg.V4);

        // 个位
        vm.mod(VReg.V4, VReg.V5, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.storeByte(VReg.A0, 3, VReg.V4);

        vm.ret();

        // 写入 3 位数字 (毫秒) 到内存
        // A0 = 目标地址, A1 = 数值
        vm.label("_write_int_padded_3");

        // 百位
        vm.movImm(VReg.V3, 100);
        vm.div(VReg.V4, VReg.A1, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.storeByte(VReg.A0, 0, VReg.V4);

        // 十位
        vm.mod(VReg.V5, VReg.A1, VReg.V3);
        vm.movImm(VReg.V3, 10);
        vm.div(VReg.V4, VReg.V5, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.storeByte(VReg.A0, 1, VReg.V4);

        // 个位
        vm.mod(VReg.V4, VReg.V5, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.storeByte(VReg.A0, 2, VReg.V4);

        vm.ret();

        // 写入 2 位数字 到内存
        // A0 = 目标地址, A1 = 数值
        vm.label("_write_int_padded_2");

        // 十位
        vm.movImm(VReg.V3, 10);
        vm.div(VReg.V4, VReg.A1, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.storeByte(VReg.A0, 0, VReg.V4);

        // 个位
        vm.mod(VReg.V4, VReg.A1, VReg.V3);
        vm.addImm(VReg.V4, VReg.V4, 48);
        vm.storeByte(VReg.A0, 1, VReg.V4);

        vm.ret();
    }

    // 带前导零打印 (保留以供其他用途)
    generatePaddedPrint() {
        const vm = this.vm;

        // 打印 4 位数字 (年份)
        vm.label("_print_int_padded_4");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        // 千位
        vm.movImm(VReg.S1, 1000);
        vm.div(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        // 百位
        vm.mod(VReg.S0, VReg.S0, VReg.S1);
        vm.movImm(VReg.S1, 100);
        vm.div(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        // 十位
        vm.mod(VReg.S0, VReg.S0, VReg.S1);
        vm.movImm(VReg.S1, 10);
        vm.div(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        // 个位
        vm.mod(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        vm.epilogue([VReg.S0, VReg.S1], 16);

        // 打印 3 位数字 (毫秒)
        vm.label("_print_int_padded_3");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        // 百位
        vm.movImm(VReg.S1, 100);
        vm.div(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        // 十位
        vm.mod(VReg.S0, VReg.S0, VReg.S1);
        vm.movImm(VReg.S1, 10);
        vm.div(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        // 个位
        vm.mod(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        vm.epilogue([VReg.S0, VReg.S1], 16);

        // 打印 2 位数字
        vm.label("_print_int_padded_2");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);

        // 十位
        vm.movImm(VReg.S1, 10);
        vm.div(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        // 个位
        vm.mod(VReg.V1, VReg.S0, VReg.S1);
        vm.addImm(VReg.V1, VReg.V1, 48);
        this.printCharFromReg(VReg.V1);

        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // 从寄存器打印字符
    printCharFromReg(reg) {
        const vm = this.vm;
        vm.push(reg);
        vm.movImm(VReg.A0, 1);
        vm.mov(VReg.A1, VReg.SP);
        vm.movImm(VReg.A2, 1);
        this.emitWriteCall();
        vm.pop(reg);
    }

    // 生成 write 系统调用
    emitWriteCall() {
        const vm = this.vm;
        if (vm.platform === "windows") {
            vm.callWindowsWriteConsole();
        } else if (vm.platform === "wasi") {
            vm.syscall(1); // wasi 号名空间 = linux-x64
        } else if (vm.arch === "arm64") {
            vm.syscall(vm.platform === "linux" ? 64 : 4);
        } else {
            vm.syscall(vm.platform === "linux" ? 1 : 0x2000004);
        }
    }

    // 解析 ISO 8601 字符串为时间戳
    // 格式: YYYY-MM-DDTHH:mm:ss.sssZ (24 字符)
    // A0 = 字符串指针
    // 返回: 时间戳 (IEEE 754 浮点位模式)
    generateParseISO() {
        const vm = this.vm;
        const arch = vm.arch;

        // 鲁棒 ISO 子集解析:接受
        //   "YYYY-MM-DD"
        //   "YYYY-MM-DDTHH:mm"、"...:ss"、"...:ss.sss"、可选尾 'Z'
        // 无时区按 UTC;任何分隔符/数字非法 → 返回 NaN 位模式。
        // A0 = 字符串值(boxed / user_ptr / 数据段裸指针均可,经 _getStrContent 归一)。
        // 栈: [SP+0]=hour [SP+8]=min [SP+16]=sec [SP+24]=ms
        vm.label("_date_parse_iso");
        vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // 原始字符串值

        // content 指针 → S1
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_getStrContent");
        vm.mov(VReg.S1, VReg.RET);
        // 长度 → S5
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S5, VReg.RET);

        // 至少 10 字符(日期部分)
        vm.cmpImm(VReg.S5, 10);
        vm.jlt("_dp_invalid");
        // 分隔符 '-' @4, @7
        vm.loadByte(VReg.V0, VReg.S1, 4);
        vm.cmpImm(VReg.V0, 45);
        vm.jne("_dp_invalid");
        vm.loadByte(VReg.V0, VReg.S1, 7);
        vm.cmpImm(VReg.V0, 45);
        vm.jne("_dp_invalid");

        // 年(4)@0 → S2, 月(2)@5 → S3, 日(2)@8 → S4
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 4);
        vm.call("_date_num");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S2, 0);
        vm.jlt("_dp_invalid");
        vm.addImm(VReg.A0, VReg.S1, 5);
        vm.movImm(VReg.A1, 2);
        vm.call("_date_num");
        vm.mov(VReg.S3, VReg.RET);
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_dp_invalid");
        vm.addImm(VReg.A0, VReg.S1, 8);
        vm.movImm(VReg.A1, 2);
        vm.call("_date_num");
        vm.mov(VReg.S4, VReg.RET);
        vm.cmpImm(VReg.S4, 0);
        vm.jlt("_dp_invalid");

        // 时间字段缺省 0
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.store(VReg.SP, 8, VReg.V0);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.store(VReg.SP, 24, VReg.V0);

        // 仅日期?(len < 16 无法容纳 THH:mm)→ 直接计算
        vm.cmpImm(VReg.S5, 16);
        vm.jlt("_dp_compute");
        // ':' @13
        vm.loadByte(VReg.V0, VReg.S1, 13);
        vm.cmpImm(VReg.V0, 58);
        vm.jne("_dp_invalid");
        // 时@11, 分@14
        vm.addImm(VReg.A0, VReg.S1, 11);
        vm.movImm(VReg.A1, 2);
        vm.call("_date_num");
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_dp_invalid");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.addImm(VReg.A0, VReg.S1, 14);
        vm.movImm(VReg.A1, 2);
        vm.call("_date_num");
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_dp_invalid");
        vm.store(VReg.SP, 8, VReg.RET);

        // 秒?(len >= 19)
        vm.cmpImm(VReg.S5, 19);
        vm.jlt("_dp_compute");
        vm.loadByte(VReg.V0, VReg.S1, 16);
        vm.cmpImm(VReg.V0, 58);
        vm.jne("_dp_invalid");
        vm.addImm(VReg.A0, VReg.S1, 17);
        vm.movImm(VReg.A1, 2);
        vm.call("_date_num");
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_dp_invalid");
        vm.store(VReg.SP, 16, VReg.RET);

        // 毫秒?('.' @19)
        vm.cmpImm(VReg.S5, 20);
        vm.jlt("_dp_compute");
        vm.loadByte(VReg.V0, VReg.S1, 19);
        vm.cmpImm(VReg.V0, 46);
        vm.jne("_dp_compute"); // 无小数点(可能是 'Z')→ ms=0
        vm.addImm(VReg.A0, VReg.S1, 20);
        vm.movImm(VReg.A1, 3);
        vm.call("_date_num");
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_dp_invalid");
        vm.store(VReg.SP, 24, VReg.RET);

        vm.label("_dp_compute");
        // days = civil_to_days(year, month(1基), day) —— 支持任意年代/日翻滚
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_date_civil_to_days");
        vm.mov(VReg.S2, VReg.RET); // S2 = days(year 已不需)
        // ms = ((days*24 + h)*60 + mi)*60 + s)*1000 + ms  (整数)
        vm.load(VReg.V3, VReg.SP, 0);
        vm.movImm(VReg.V4, 24);
        vm.mul(VReg.V5, VReg.S2, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 8);
        vm.movImm(VReg.V4, 60);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 16);
        vm.movImm(VReg.V4, 60);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.movImm(VReg.V4, 1000);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.load(VReg.V3, VReg.SP, 24);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.scvtf(0, VReg.V5);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        vm.label("_dp_invalid");
        // 非别名 NaN 0x7ff0…01(canonical 0x7ff8… 与装箱 int0 位别名 → Date.parse 非法
        // 串打印 0、isNaN 假,nan-int0 陷阱;高16=0x7FF0 打印 "NaN"、语义正确)。
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        // _date_num(A0=ptr, A1=n) -> 值(全数字) 或 -1(遇非数字)
        vm.label("_date_num");
        vm.movImm(VReg.V3, 0); // result
        vm.label("_date_num_loop");
        vm.cmpImm(VReg.A1, 0);
        vm.jle("_date_num_done");
        vm.loadByte(VReg.V5, VReg.A0, 0);
        vm.cmpImm(VReg.V5, 48); // '0'
        vm.jlt("_date_num_bad");
        vm.cmpImm(VReg.V5, 57); // '9'
        vm.jgt("_date_num_bad");
        vm.movImm(VReg.V4, 10);
        vm.mul(VReg.V3, VReg.V3, VReg.V4);
        vm.subImm(VReg.V5, VReg.V5, 48);
        vm.add(VReg.V3, VReg.V3, VReg.V5);
        vm.addImm(VReg.A0, VReg.A0, 1);
        vm.subImm(VReg.A1, VReg.A1, 1);
        vm.jmp("_date_num_loop");
        vm.label("_date_num_done");
        vm.mov(VReg.RET, VReg.V3);
        vm.ret();
        vm.label("_date_num_bad");
        vm.movImm(VReg.RET, 0);
        vm.subImm(VReg.RET, VReg.RET, 1); // -1
        vm.ret();

        // _date_civil_to_days(A0=y, A1=m(1-12), A2=d) -> 从 1970-01-01 的天数
        // Howard Hinnant days_from_civil(截断除法+era 调整,全年代正确;
        // 日/年内线性,d 或月归一后的溢出天然翻滚)。
        vm.label("_date_civil_to_days");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // y
        vm.mov(VReg.S1, VReg.A1); // m
        vm.mov(VReg.S2, VReg.A2); // d
        // y -= (m <= 2)
        vm.cmpImm(VReg.S1, 2);
        vm.jgt("_dc_mgt2");
        vm.subImm(VReg.S0, VReg.S0, 1);
        vm.label("_dc_mgt2");
        // era = (y>=0 ? y : y-399) / 400  → S3
        vm.mov(VReg.V3, VReg.S0);
        vm.cmpImm(VReg.V3, 0);
        vm.jge("_dc_epos");
        vm.subImm(VReg.V3, VReg.V3, 399);
        vm.label("_dc_epos");
        vm.movImm(VReg.V5, 400);
        vm.div(VReg.S3, VReg.V3, VReg.V5); // era
        // yoe = y - era*400  → S0
        vm.movImm(VReg.V5, 400);
        vm.mul(VReg.V3, VReg.S3, VReg.V5);
        vm.sub(VReg.S0, VReg.S0, VReg.V3); // yoe
        // mp = m + (m>2 ? -3 : 9)  → V3
        vm.mov(VReg.V3, VReg.S1);
        vm.cmpImm(VReg.S1, 2);
        vm.jgt("_dc_mpgt2");
        vm.addImm(VReg.V3, VReg.V3, 9);
        vm.jmp("_dc_mpd");
        vm.label("_dc_mpgt2");
        vm.subImm(VReg.V3, VReg.V3, 3);
        vm.label("_dc_mpd");
        // doy = (153*mp + 2)/5 + d - 1  → S1
        vm.movImm(VReg.V5, 153);
        vm.mul(VReg.V3, VReg.V3, VReg.V5);
        vm.addImm(VReg.V3, VReg.V3, 2);
        vm.movImm(VReg.V5, 5);
        vm.div(VReg.V4, VReg.V3, VReg.V5);
        vm.add(VReg.V4, VReg.V4, VReg.S2);
        vm.subImm(VReg.V4, VReg.V4, 1);
        vm.mov(VReg.S1, VReg.V4); // doy
        // doe = yoe*365 + yoe/4 - yoe/100 + doy  → V4
        vm.movImm(VReg.V5, 365);
        vm.mul(VReg.V4, VReg.S0, VReg.V5);
        vm.movImm(VReg.V5, 4);
        vm.div(VReg.V3, VReg.S0, VReg.V5);
        vm.add(VReg.V4, VReg.V4, VReg.V3);
        vm.movImm(VReg.V5, 100);
        vm.div(VReg.V3, VReg.S0, VReg.V5);
        vm.sub(VReg.V4, VReg.V4, VReg.V3);
        vm.add(VReg.V4, VReg.V4, VReg.S1); // + doy
        // days = era*146097 + doe - 719468
        vm.movImm(VReg.V5, 146097);
        vm.mul(VReg.V3, VReg.S3, VReg.V5);
        vm.add(VReg.V4, VReg.V4, VReg.V3);
        vm.movImm(VReg.V5, 719468);
        vm.sub(VReg.V4, VReg.V4, VReg.V5);
        vm.mov(VReg.RET, VReg.V4);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // _date_set_part(A0=date, A1=part, A2=value(int)) -> 新 ms(裸 float 位)
        // part: 0=year 1=month(0基) 2=date 3=hours 4=minutes 5=seconds 6=ms
        // 就地修改 date.timestamp;溢出翻滚由 civil_to_days 线性历法天然满足。
        // 栈: [0]year [8]month0 [16]day [24]hours [32]min [40]sec [48]ms
        //     [56]boxed date [64]part [72]value
        vm.label("_date_set_part");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.store(VReg.SP, 56, VReg.A0);
        vm.store(VReg.SP, 64, VReg.A1);
        vm.store(VReg.SP, 72, VReg.A2);
        // 采集现字段(get_part: 0..5;7=ms → 槽 6)
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 0); vm.call("_date_get_part"); vm.store(VReg.SP, 0, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 1); vm.call("_date_get_part"); vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 2); vm.call("_date_get_part"); vm.store(VReg.SP, 16, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 3); vm.call("_date_get_part"); vm.store(VReg.SP, 24, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 4); vm.call("_date_get_part"); vm.store(VReg.SP, 32, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 5); vm.call("_date_get_part"); vm.store(VReg.SP, 40, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 7); vm.call("_date_get_part"); vm.store(VReg.SP, 48, VReg.RET);
        // 覆写 slot[part] = value
        vm.load(VReg.V3, VReg.SP, 64);
        vm.load(VReg.V4, VReg.SP, 72);
        vm.movImm(VReg.V5, 8);
        vm.mul(VReg.V3, VReg.V3, VReg.V5);
        vm.mov(VReg.V5, VReg.SP);
        vm.add(VReg.V3, VReg.V5, VReg.V3);
        vm.store(VReg.V3, 0, VReg.V4);
        // 归一化月:year += floor(month0/12); month0 -> [0,11]
        vm.load(VReg.S0, VReg.SP, 0);  // year
        vm.load(VReg.S1, VReg.SP, 8);  // month0
        vm.movImm(VReg.V5, 12);
        vm.div(VReg.V3, VReg.S1, VReg.V5); // q
        vm.mod(VReg.V4, VReg.S1, VReg.V5); // r
        vm.cmpImm(VReg.V4, 0);
        vm.jge("_dsp_mnorm");
        vm.subImm(VReg.V3, VReg.V3, 1);
        vm.addImm(VReg.V4, VReg.V4, 12);
        vm.label("_dsp_mnorm");
        vm.add(VReg.S0, VReg.S0, VReg.V3); // adjusted year
        vm.addImm(VReg.V4, VReg.V4, 1);    // m1 (1基)
        // days = civil_to_days(year, m1, day)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V4);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.call("_date_civil_to_days");
        vm.mov(VReg.S1, VReg.RET); // days
        // ms = ((days*24 + h)*60 + mi)*60 + s)*1000 + ms
        vm.load(VReg.V3, VReg.SP, 24);
        vm.movImm(VReg.V4, 24);
        vm.mul(VReg.V5, VReg.S1, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 32);
        vm.movImm(VReg.V4, 60);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 40);
        vm.movImm(VReg.V4, 60);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.movImm(VReg.V4, 1000);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.load(VReg.V3, VReg.SP, 48);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        // 写回 & 返回
        vm.scvtf(0, VReg.V5);
        vm.fmovToInt(VReg.V3, 0); // 新 ms 的 float 位
        vm.load(VReg.V4, VReg.SP, 56);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V4, VReg.V4, VReg.V1);
        vm.store(VReg.V4, 8, VReg.V3);
        vm.mov(VReg.RET, VReg.V3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 128);

        // _date_set_parts(A0=date, A1=startPart, A2=count, A3=valuesPtr) -> 新 ms(裸 float 位)
        // 原子多字段 setter(setFullYear(y,m,d)/setHours(h,mi,s,ms) 等):一次拆全字段,
        // 覆写 slot[startPart..startPart+count-1] = values[0..count-1],再单次归一化+重组。
        // (sequential 逐 _date_set_part 会在中间字段溢出翻滚后被下一字段读到错误月份,
        //  故必须原子。)values[i] 为 int64,位于 valuesPtr + i*8(升序地址,升序 part)。
        // 栈: [0]year [8]month0 [16]day [24]hours [32]min [40]sec [48]ms
        //     [56]boxed date [64]startPart [72]count [80]valuesPtr
        vm.label("_date_set_parts");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.store(VReg.SP, 56, VReg.A0);
        vm.store(VReg.SP, 64, VReg.A1);
        vm.store(VReg.SP, 72, VReg.A2);
        vm.store(VReg.SP, 80, VReg.A3);
        // 采集现字段(get_part: 0..5;7=ms → 槽 6)
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 0); vm.call("_date_get_part"); vm.store(VReg.SP, 0, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 1); vm.call("_date_get_part"); vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 2); vm.call("_date_get_part"); vm.store(VReg.SP, 16, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 3); vm.call("_date_get_part"); vm.store(VReg.SP, 24, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 4); vm.call("_date_get_part"); vm.store(VReg.SP, 32, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 5); vm.call("_date_get_part"); vm.store(VReg.SP, 40, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 56); vm.movImm(VReg.A1, 7); vm.call("_date_get_part"); vm.store(VReg.SP, 48, VReg.RET);
        // 覆写循环: for i in [0,count): slot[(startPart+i)*8] = values[i]
        vm.load(VReg.S0, VReg.SP, 64); // startPart
        vm.load(VReg.S1, VReg.SP, 72); // count
        vm.load(VReg.S2, VReg.SP, 80); // valuesPtr
        vm.movImm(VReg.S3, 0);         // i
        vm.label("_dsps_loop");
        vm.cmp(VReg.S3, VReg.S1);
        vm.jge("_dsps_done");
        // 仅用 V3/V4 做地址算术:x64 上 V5=R10、V6=R11 是 add/mul 的内部 scratch
        // (tempA/tempB),把它们当算术操作数会被覆盖(x64 多字段全 0/垃圾根因)。
        // &slot = SP + (startPart+i)*8,落 V3
        vm.add(VReg.V3, VReg.S0, VReg.S3);
        vm.movImm(VReg.V4, 8);
        vm.mul(VReg.V3, VReg.V3, VReg.V4); // dest==a
        vm.mov(VReg.V4, VReg.SP);
        vm.add(VReg.V3, VReg.V4, VReg.V3); // V3 = SP + V3 (&slot)
        // value = *(valuesPtr + i*8),落 V4(V3 保留)
        vm.movImm(VReg.V4, 8);
        vm.mul(VReg.V4, VReg.S3, VReg.V4); // V4 = i*8(dest=R9≠R10,安全)
        vm.add(VReg.V4, VReg.V4, VReg.S2); // dest==a,V4 = valuesPtr + i*8
        vm.load(VReg.V4, VReg.V4, 0);      // V4 = value
        vm.store(VReg.V3, 0, VReg.V4);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_dsps_loop");
        vm.label("_dsps_done");
        // 归一化月:year += floor(month0/12); month0 -> [0,11](与 _date_set_part 尾同)
        vm.load(VReg.S0, VReg.SP, 0);  // year
        vm.load(VReg.S1, VReg.SP, 8);  // month0
        vm.movImm(VReg.V5, 12);
        vm.div(VReg.V3, VReg.S1, VReg.V5); // q
        vm.mod(VReg.V4, VReg.S1, VReg.V5); // r
        vm.cmpImm(VReg.V4, 0);
        vm.jge("_dsps_mnorm");
        vm.subImm(VReg.V3, VReg.V3, 1);
        vm.addImm(VReg.V4, VReg.V4, 12);
        vm.label("_dsps_mnorm");
        vm.add(VReg.S0, VReg.S0, VReg.V3); // adjusted year
        vm.addImm(VReg.V4, VReg.V4, 1);    // m1 (1基)
        // days = civil_to_days(year, m1, day)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V4);
        vm.load(VReg.A2, VReg.SP, 16);
        vm.call("_date_civil_to_days");
        vm.mov(VReg.S1, VReg.RET); // days
        // ms = (((days*24 + h)*60 + mi)*60 + s)*1000 + ms
        vm.load(VReg.V3, VReg.SP, 24);
        vm.movImm(VReg.V4, 24);
        vm.mul(VReg.V5, VReg.S1, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 32);
        vm.movImm(VReg.V4, 60);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 40);
        vm.movImm(VReg.V4, 60);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.movImm(VReg.V4, 1000);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.load(VReg.V3, VReg.SP, 48);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        // 写回 & 返回
        vm.scvtf(0, VReg.V5);
        vm.fmovToInt(VReg.V3, 0);
        vm.load(VReg.V4, VReg.SP, 56);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V4, VReg.V4, VReg.V1);
        vm.store(VReg.V4, 8, VReg.V3);
        vm.mov(VReg.RET, VReg.V3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);

        // _parse_int_n: 解析 N 位数字
        // A0 = 字符串指针, A1 = 位数
        // 返回: 解析的整数值
        vm.label("_parse_int_n");
        // 叶子函数，使用 V3-V5
        vm.movImm(VReg.V3, 0); // result = 0
        vm.movImm(VReg.V4, 0); // i = 0

        const parseLoop = "_parse_int_loop";
        const parseDone = "_parse_int_done";

        vm.label(parseLoop);
        vm.cmp(VReg.V4, VReg.A1);
        vm.jge(parseDone);

        // result = result * 10
        vm.movImm(VReg.V5, 10);
        vm.mul(VReg.V3, VReg.V3, VReg.V5);

        // 加载字符
        vm.loadByte(VReg.V5, VReg.A0, 0);
        vm.subImm(VReg.V5, VReg.V5, 48); // '0' = 48
        vm.add(VReg.V3, VReg.V3, VReg.V5);

        vm.addImm(VReg.A0, VReg.A0, 1); // ptr++
        vm.addImm(VReg.V4, VReg.V4, 1); // i++
        vm.jmp(parseLoop);

        vm.label(parseDone);
        vm.mov(VReg.RET, VReg.V3);
        vm.ret();

        // _date_ymd_to_days: 年月日转换为从 1970-01-01 的天数
        // A0 = year, A1 = month, A2 = day
        // 返回: 天数
        vm.label("_date_ymd_to_days");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // year
        vm.mov(VReg.S1, VReg.A1); // month
        vm.mov(VReg.S2, VReg.A2); // day

        // 计算从 1970 年到 year-1 的天数
        vm.movImm(VReg.S3, 0); // total_days = 0
        vm.movImm(VReg.V3, 1970); // y = 1970

        const yearLoop = "_ymd_year_loop";
        const yearDone = "_ymd_year_done";

        vm.label(yearLoop);
        vm.cmp(VReg.V3, VReg.S0);
        vm.jge(yearDone);

        vm.mov(VReg.A0, VReg.V3);
        vm.call("_date_year_days");
        vm.add(VReg.S3, VReg.S3, VReg.RET);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp(yearLoop);

        vm.label(yearDone);

        // 计算从 1 月到 month-1 的天数
        vm.movImm(VReg.V3, 1); // m = 1

        const monthLoop = "_ymd_month_loop";
        const monthDone = "_ymd_month_done";

        vm.label(monthLoop);
        vm.cmp(VReg.V3, VReg.S1);
        vm.jge(monthDone);

        vm.mov(VReg.A0, VReg.S0); // year
        vm.mov(VReg.A1, VReg.V3); // month
        vm.call("_date_month_days");
        vm.add(VReg.S3, VReg.S3, VReg.RET);
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.jmp(monthLoop);

        vm.label(monthDone);

        // 加上 day - 1
        vm.subImm(VReg.V3, VReg.S2, 1);
        vm.add(VReg.RET, VReg.S3, VReg.V3);

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }
}
