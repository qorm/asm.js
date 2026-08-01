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
        // [Date 加固] this 类型检查:原型方法 .call({})/.call(null) 等非 Date 接收者
        // 抛 TypeError("this is not a Date object."),不再无防护读 [this+8](段错误根因)。
        vm.prologue(0, []);
        vm.call("_date_this_get"); // RET = 裸 date 指针(非 Date 不返回)
        vm.load(VReg.RET, VReg.RET, 8);
        vm.epilogue([], 0);

        // _date_toString - "Www Mmm DD YYYY HH:mm:ss GMT+0000 (Coordinated Universal Time)"
        // A0 = Date 值(装箱 0x7ffd 或裸指针;非 Date 接收者 → TypeError,见 _date_this_named)。
        // 与 node 逐字对齐的 V8 格式:星期/月英文缩写、日/时/分/秒 2 位前导零、
        // 年份 0..9999 四位前导零、负年 '-' + ≥4 位、>9999 无符号直写(注意:toString 不打
        // '+' —— ±YYYYYY 扩展形只属 toISOString/解析,见 _date_toISOString/_date_parse_iso)。
        // Invalid Date(timestamp NaN/±Inf)→ "Invalid Date"。本运行时全 UTC,时区段恒定。
        vm.label("_date_toString");
        vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.lea(VReg.A1, vm.asm.addString("toString"));
        vm.call("_date_this_named"); // RET = 裸 date 指针(非 Date 不返回)
        vm.store(VReg.SP, 40, VReg.RET);
        // Invalid Date:timestamp 指数全 1(NaN/±Inf)→ "Invalid Date"
        vm.load(VReg.V1, VReg.RET, 8);
        vm.shrImm(VReg.V0, VReg.V1, 52);
        vm.andImm(VReg.V0, VReg.V0, 0x7ff);
        vm.cmpImm(VReg.V0, 0x7ff);
        vm.jne("_dts_valid");
        vm.lea(VReg.A0, vm.asm.addString("Invalid Date"));
        vm.call("_cstr_to_heap_str");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);
        vm.label("_dts_valid");
        // 经 _date_get_part 逐字段拆解(get_part 会破坏 S3-S5,全部经栈中转,布局同 toISOString)
        // 栈: [8]sec [16]min [24]hour [32]strblock [40]date [48]year [56]month0 [64]day [72]dow
        //     [80]digits [88]sign
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 5); vm.call("_date_get_part"); vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 4); vm.call("_date_get_part"); vm.store(VReg.SP, 16, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 3); vm.call("_date_get_part"); vm.store(VReg.SP, 24, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 0); vm.call("_date_get_part"); vm.store(VReg.SP, 48, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 1); vm.call("_date_get_part"); vm.store(VReg.SP, 56, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 2); vm.call("_date_get_part"); vm.store(VReg.SP, 64, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 6); vm.call("_date_get_part"); vm.store(VReg.SP, 72, VReg.RET);

        // 年字段宽度:V1=sign(负年 1),V2=digits(负年/0..9999 至少 4 位,>9999 按实际位数)
        vm.load(VReg.V0, VReg.SP, 48); // year
        vm.movImm(VReg.V1, 0); // sign
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_dts_abs_done");
        vm.movImm(VReg.V1, 1);
        vm.mov(VReg.V2, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.sub(VReg.V0, VReg.V0, VReg.V2); // ay = -year(dest==a 既有形态)
        vm.label("_dts_abs_done");
        // ndig(ay):V2 = 十进制位数(ay=0 得 1,由下方 4 位规则兜底)
        vm.movImm(VReg.V2, 1);
        vm.mov(VReg.V3, VReg.V0);
        vm.movImm(VReg.V4, 10);
        vm.label("_dts_nd_loop");
        vm.cmpImm(VReg.V3, 10);
        vm.jlt("_dts_nd_done");
        vm.div(VReg.V3, VReg.V3, VReg.V4);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.jmp("_dts_nd_loop");
        vm.label("_dts_nd_done");
        vm.load(VReg.V3, VReg.SP, 48); // year
        vm.cmpImm(VReg.V3, 0);
        vm.jlt("_dts_pad4");
        vm.cmpImm(VReg.V3, 9999);
        vm.jgt("_dts_d_done");
        vm.label("_dts_pad4");
        vm.cmpImm(VReg.V2, 4);
        vm.jge("_dts_d_done");
        vm.movImm(VReg.V2, 4);
        vm.label("_dts_d_done");
        vm.store(VReg.SP, 80, VReg.V2); // digits
        vm.store(VReg.SP, 88, VReg.V1); // sign

        // 总长 len = 58 + digits + sign("Www Mmm DD " 11 + 年字段 + " " 1 + "HH:mm:ss" 8
        // + " GMT+0000 (Coordinated Universal Time)" 38);size = align8(16 + len + 1)
        vm.load(VReg.V0, VReg.SP, 80);
        vm.load(VReg.V1, VReg.SP, 88);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.addImm(VReg.V0, VReg.V0, 75);
        vm.addImm(VReg.V0, VReg.V0, 7);
        vm.movImm64(VReg.V1, 0xfffffffffffffff8n);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_alloc");
        vm.store(VReg.SP, 32, VReg.RET); // 字符串块指针落栈(alloc 后寄存器即毁)

        // 字符串头:[type=6 保高位][length](与 toISOString 同款,保 GC size/mark 高位)
        vm.load(VReg.S0, VReg.SP, 32);
        vm.load(VReg.V0, VReg.S0, 0);
        vm.movImm64(VReg.V1, 0xffffffffffffff00n);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V1, TYPE_STRING);
        vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.S0, 0, VReg.V0);
        vm.load(VReg.V0, VReg.SP, 80);
        vm.load(VReg.V1, VReg.SP, 88);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.addImm(VReg.V0, VReg.V0, 58);
        vm.store(VReg.S0, 8, VReg.V0);

        // S1 = 内容起始(block+16);S3=year S4=month0 S5=day(写入函数均为叶子,不毁 S)
        vm.load(VReg.S1, VReg.SP, 32);
        vm.addImm(VReg.S1, VReg.S1, 16);
        vm.load(VReg.S3, VReg.SP, 48);
        vm.load(VReg.S4, VReg.SP, 56);
        vm.load(VReg.S5, VReg.SP, 64);

        // [0..2] 星期缩写("SunMonTueWedThuFriSat" + dow*3)
        vm.load(VReg.V1, VReg.SP, 72);
        vm.movImm(VReg.V2, 3);
        vm.mul(VReg.V1, VReg.V1, VReg.V2);
        vm.lea(VReg.V0, vm.asm.addString("SunMonTueWedThuFriSat"));
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.storeByte(VReg.S1, 0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.storeByte(VReg.S1, 1, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 2);
        vm.storeByte(VReg.S1, 2, VReg.V1);
        // [3] ' '
        vm.movImm(VReg.V0, 32);
        vm.storeByte(VReg.S1, 3, VReg.V0);
        // [4..6] 月缩写("JanFeb...Dec" + month0*3)
        vm.movImm(VReg.V2, 3);
        vm.mul(VReg.V1, VReg.S4, VReg.V2);
        vm.lea(VReg.V0, vm.asm.addString("JanFebMarAprMayJunJulAugSepOctNovDec"));
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.storeByte(VReg.S1, 4, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 1);
        vm.storeByte(VReg.S1, 5, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V0, 2);
        vm.storeByte(VReg.S1, 6, VReg.V1);
        // [7] ' '
        vm.movImm(VReg.V0, 32);
        vm.storeByte(VReg.S1, 7, VReg.V0);
        // [8..9] 日(2 位)
        vm.addImm(VReg.A0, VReg.S1, 8);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_write_int_padded_2");
        // [10] ' '
        vm.movImm(VReg.V0, 32);
        vm.storeByte(VReg.S1, 10, VReg.V0);
        // [11] 起年字段(可选 '-' + digits 位,_date_write_num_rev 自带前导零)
        vm.load(VReg.V1, VReg.SP, 88);
        vm.cmpImm(VReg.V1, 1);
        vm.jne("_dts_y_nosign");
        vm.movImm(VReg.V0, 45); // '-'
        vm.storeByte(VReg.S1, 11, VReg.V0);
        vm.label("_dts_y_nosign");
        vm.load(VReg.V1, VReg.SP, 88);
        vm.addImm(VReg.A0, VReg.S1, 11);
        vm.add(VReg.A0, VReg.A0, VReg.V1); // A0 = 年数字起始(x64 V1==A3,A3 无活值)
        vm.mov(VReg.A1, VReg.S3); // year
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_dts_y_abs");
        vm.mov(VReg.V2, VReg.A1);
        vm.movImm(VReg.A1, 0);
        vm.sub(VReg.A1, VReg.A1, VReg.V2); // A1 = |year|(x64 V2==A2,此后才装 A2)
        vm.label("_dts_y_abs");
        vm.load(VReg.A2, VReg.SP, 80); // digits
        vm.call("_date_write_num_rev");

        // S2 = 时间基址 = content + 12 + ylen(' ' 在其前一格;不用负偏移 storeByte)
        vm.load(VReg.V0, VReg.SP, 80);
        vm.load(VReg.V1, VReg.SP, 88);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.addImm(VReg.S2, VReg.S1, 12);
        vm.add(VReg.S2, VReg.S2, VReg.V0);
        vm.movImm(VReg.V0, 32); // ' '
        vm.subImm(VReg.V1, VReg.S2, 1);
        vm.storeByte(VReg.V1, 0, VReg.V0);
        // HH:mm:ss(2 位 ×3,':' 分隔)
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.SP, 24); // hour
        vm.call("_write_int_padded_2");
        vm.movImm(VReg.V0, 58); // ':'
        vm.storeByte(VReg.S2, 2, VReg.V0);
        vm.addImm(VReg.A0, VReg.S2, 3);
        vm.load(VReg.A1, VReg.SP, 16); // min
        vm.call("_write_int_padded_2");
        vm.movImm(VReg.V0, 58);
        vm.storeByte(VReg.S2, 5, VReg.V0);
        vm.addImm(VReg.A0, VReg.S2, 6);
        vm.load(VReg.A1, VReg.SP, 8); // sec
        vm.call("_write_int_padded_2");
        // " GMT+0000 (Coordinated Universal Time)"(38 字节)@ time+8
        vm.lea(VReg.V0, vm.asm.addString(" GMT+0000 (Coordinated Universal Time)"));
        vm.addImm(VReg.V1, VReg.S2, 8);
        vm.movImm(VReg.V2, 38);
        vm.label("_dts_tail_loop");
        vm.loadByte(VReg.V3, VReg.V0, 0);
        vm.storeByte(VReg.V1, 0, VReg.V3);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.subImm(VReg.V2, VReg.V2, 1);
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_dts_tail_loop");
        // NUL @ time+46(= 58+ylen)
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S2, 46, VReg.V0);

        // 返回装箱字符串值(content|0x7FFC,与 _date_toISOString 尾部同式)
        vm.load(VReg.RET, VReg.SP, 32);
        vm.addImm(VReg.RET, VReg.RET, 16);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 96);

        // 生成 toISOString 相关辅助函数
        this.generateToISOString();

        // [Date 一等值] 物化 Date/Date.prototype 所需的运行时入口(无条件发射,
        // 与 _date_now 同,使 gen1/gen2/gen3 链接同一组标签)。
        this.generateDateValueHelpers();
    }

    // [Date 一等值] 裸 `Date` 作值传递后调用(`const D=Date; D()`)与原型方法引用
    // (Date.prototype.getTime.call(d) 等)所需的运行时 helper。调用位/静态成员读
    // (functions.js 的 Date.now/parse/UTC 与 HOISTED_DATE_METHODS 派发)先于值路径
    // 命中,不经此族 → 既有快路字节不变。
    generateDateValueHelpers() {
        const vm = this.vm;

        // _date_call - Date() 不带 new(经值路径调用)→ 当前时间的 ISO 字符串(装箱)。
        // ES:Date() 返回字符串。本运行时全 UTC、toString===toISOString,故取 now 建
        // Date 再 toISOString(_date_new(0) 的 0→now 语义 + _date_toISOString 已装箱)。
        vm.label("_date_call");
        vm.prologue(0, []);
        vm.movImm(VReg.A0, 0);
        vm.call("_date_new");          // RET = 装箱 Date(now)
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_date_toISOString");  // RET = 装箱 ISO 字符串
        vm.epilogue([], 0);

        // _date_utc - Date.UTC 作**值**调用(emitMemoizedBuiltinRef 的 16B 闭包 fnptr)。
        // 调用约定:A0-A5 = y,mo,d,h,mi,s(装箱,缺参=undefined);ms 不在寄存器入参,
        // 缺省 0(直调 Date.UTC(…,ms) 的 7 参形态仍走 functions.js 内联快路,不受此限)。
        // 历法复用 _date_civil_to_days(与 emitDateUTCms 同源 Hinnant),ms 重组式逐字同
        // emitDateUTCms 尾段(msArg=0)。RET = 裸 float64 毫秒(number)。
        vm.label("_date_utc");
        vm.prologue(128, [VReg.S0]);
        // 装箱入参先落栈(_aref_argint_d 会毁 A 寄存器)
        vm.store(VReg.SP, 0, VReg.A0);
        vm.store(VReg.SP, 8, VReg.A1);
        vm.store(VReg.SP, 16, VReg.A2);
        vm.store(VReg.SP, 24, VReg.A3);
        vm.store(VReg.SP, 32, VReg.A4);
        vm.store(VReg.SP, 40, VReg.A5);
        // 装箱 → 裸 int(缺省:y/mo/h/mi/s=0,d=1;同 ES Date.UTC 缺省)
        vm.load(VReg.A0, VReg.SP, 0);  vm.movImm(VReg.A1, 0); vm.call("_aref_argint_d"); vm.store(VReg.SP, 64, VReg.RET);  // y
        vm.load(VReg.A0, VReg.SP, 8);  vm.movImm(VReg.A1, 0); vm.call("_aref_argint_d"); vm.store(VReg.SP, 72, VReg.RET);  // mo
        vm.load(VReg.A0, VReg.SP, 16); vm.movImm(VReg.A1, 1); vm.call("_aref_argint_d"); vm.store(VReg.SP, 80, VReg.RET);  // d
        vm.load(VReg.A0, VReg.SP, 24); vm.movImm(VReg.A1, 0); vm.call("_aref_argint_d"); vm.store(VReg.SP, 88, VReg.RET);  // h
        vm.load(VReg.A0, VReg.SP, 32); vm.movImm(VReg.A1, 0); vm.call("_aref_argint_d"); vm.store(VReg.SP, 96, VReg.RET);  // mi
        vm.load(VReg.A0, VReg.SP, 40); vm.movImm(VReg.A1, 0); vm.call("_aref_argint_d"); vm.store(VReg.SP, 104, VReg.RET); // s
        // days = civil_to_days(y, mo+1, d)
        vm.load(VReg.A0, VReg.SP, 64);
        vm.load(VReg.A1, VReg.SP, 72);
        vm.addImm(VReg.A1, VReg.A1, 1); // m(1 基)
        vm.load(VReg.A2, VReg.SP, 80);
        vm.call("_date_civil_to_days");
        vm.mov(VReg.S0, VReg.RET);      // S0 = days
        // ms = ((days*24 + h)*60 + mi)*60000 + s*1000
        vm.load(VReg.V3, VReg.SP, 88);
        vm.movImm(VReg.V4, 24);
        vm.mul(VReg.V5, VReg.S0, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 96);
        vm.movImm(VReg.V4, 60);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3);
        vm.movImm(VReg.V4, 60000);
        vm.mul(VReg.V5, VReg.V5, VReg.V4);
        vm.load(VReg.V3, VReg.SP, 104);
        vm.movImm(VReg.V4, 1000);
        vm.mul(VReg.V3, VReg.V3, VReg.V4);
        vm.add(VReg.V5, VReg.V5, VReg.V3); // V5 = ms(整数)
        vm.scvtf(0, VReg.V5);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([VReg.S0], 128);

        // getter 族 wrapper:_aref_generic 把 this 插 A0、用户实参上移( getter 无视之)。
        // [Date 加固] 先经 _date_this_get 校验接收者(非 Date 抛 TypeError,不再无防护读
        // [this+8])。各 wrapper 覆写 A1 = part 码、调 _date_get_part_num(Invalid → NaN,
        // 否则裸 int 装箱 number)。part: 0=year 1=month(0基) 2=date 3=hours 4=minutes
        // 5=seconds 6=day-of-week 7=ms。UTC 变体与本地变体同 part(本运行时全 UTC)
        // → 两名共享同一 wrapper。
        for (let part = 0; part <= 7; part = part + 1) {
            vm.label("_aref_date_gp" + part);
            vm.prologue(0, []);
            vm.call("_date_this_get"); // 非 Date 抛 TypeError;RET = 裸 date 指针
            vm.mov(VReg.A0, VReg.RET);
            vm.movImm(VReg.A1, part);
            vm.call("_date_get_part_num"); // RET = number(Invalid → canonical NaN)
            vm.epilogue([], 0);
        }

        // _date_get_part_num(A0=date(装箱 0x7ffd 或裸指针), A1=part) -> RET = number(float64 位)
        // [Date 加固] 装箱版 _date_get_part:timestamp 指数全 1(Invalid Date)→ canonical
        // NaN(0x7ff0…01,同 _dp_invalid);否则委托 _date_get_part 取裸 int 后 scvtf 装箱
        // (尾巴同 boxIntAsNumber/原 _aref_date_gp*)。此前调用方对 ts 直接 fcvtzs,
        // NaN→0 → Invalid Date 的 getter 全返 1970 字段(规范 NaN;直调 compileDateMethod
        // 与 aref 两路同病)。_date_toString/toISOString 内部已先查 Invalid,继续用裸
        // _date_get_part,不动。位提取等值判别为既有惯例(_date_toString:266-269),不触 §1.2。
        vm.label("_date_get_part_num");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // date
        vm.mov(VReg.S1, VReg.A1); // part
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1); // 裸 date 指针(V0==A0 别名,dest==src 既有形态)
        vm.load(VReg.V0, VReg.V0, 8); // ts(float64 位)
        vm.shrImm(VReg.V1, VReg.V0, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7ff);
        vm.cmpImm(VReg.V1, 0x7ff);
        vm.jne("_dgpn_valid");
        vm.movImm64(VReg.RET, 0x7ff0000000000001n); // canonical NaN(number)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_dgpn_valid");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_date_get_part"); // RET = 裸 int
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0); // 装箱 number
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // setter 族 wrapper(原子多字段,_date_set_parts;直调仍经 functions.js 内联快路)。
        // [Date 加固] ①接收者经 _date_this_named 校验(非 Date 按 V8 文案抛 TypeError;
        // UTC 变体共享 wrapper,消息用基名,记偏差)。②实参由 _aref_argint 换成 _number_coerce
        // 真 ToNumber(对象 valueOf/字符串数字强转/null→0/bool/undefined→NaN),按 [_call_argc]
        // 供给个数逐位强转(顺序与规范一致),缺省位取现字段(_date_set_parts 只覆写前 count 槽);
        // 任一位 NaN/±Inf(指数全 1)→ timestamp 写 NaN 并返回 NaN(Invalid Date)。
        // part: 0=year 1=month0 2=date 3=h 4=mi 5=s 6=ms;max 为各 setter 形参上限。
        // 栈: [0..32]A1-A5 实参 [40..64]values(≤4) —— 帧 96。
        const SP_NAMES = ["setFullYear", "setMonth", "setDate", "setHours", "setMinutes", "setSeconds", "setMilliseconds"];
        const SP_MAX = [3, 2, 1, 4, 3, 2, 1];
        for (let part = 0; part <= 6; part = part + 1) {
            const maxA = SP_MAX[part];
            const L = "_aref_date_sp" + part;
            vm.label(L);
            vm.prologue(96, [VReg.S0, VReg.S1, VReg.S2]);
            // 实参先落栈(_date_this_named/_number_coerce 毁 A 寄存器)
            vm.store(VReg.SP, 0, VReg.A1);
            vm.store(VReg.SP, 8, VReg.A2);
            vm.store(VReg.SP, 16, VReg.A3);
            vm.store(VReg.SP, 24, VReg.A4);
            vm.store(VReg.SP, 32, VReg.A5);
            vm.lea(VReg.A1, vm.asm.addString(SP_NAMES[part]));
            vm.call("_date_this_named"); // 非 Date 抛 TypeError;RET = 裸 date 指针
            vm.mov(VReg.S0, VReg.RET);
            // [Date 加固] t=[[DateValue]] 读取时点(V8 实测对齐,落 [SP+72] 供 A4):
            //  part 1..6:全部强转**前**读(ES 顺序);且 t 指数全 1 → S2=1(Invalid:强转
            //   照做保副作用,返 NaN 且【不写回】)。
            //  part=0(setFullYear):**year 强转后、month/date 强转前**读(V8:year 的
            //   valueOf 改 t 影响缺省月日,month 的 valueOf 改 t 不影响);NaN→+0 由
            //   _date_set_parts_t 内 fcvtzs(NaN)=0 天然满足,不置 S2。
            vm.movImm(VReg.S2, 0);
            if (part !== 0) {
                vm.load(VReg.V0, VReg.S0, 8);
                vm.store(VReg.SP, 72, VReg.V0);
                vm.shrImm(VReg.V1, VReg.V0, 52);
                vm.andImm(VReg.V1, VReg.V1, 0x7ff);
                vm.cmpImm(VReg.V1, 0x7ff);
                vm.jne(L + "_fresh");
                vm.movImm(VReg.S2, 1);
                vm.label(L + "_fresh");
            }
            // count = min(supplied, max);零参按 1(arg0=padded undefined → NaN)
            vm.lea(VReg.V1, "_call_argc");
            vm.load(VReg.S1, VReg.V1, 0);
            vm.cmpImm(VReg.S1, 1);
            vm.jge(L + "_c1");
            vm.movImm(VReg.S1, 1);
            vm.jmp(L + "_cok");
            vm.label(L + "_c1");
            vm.cmpImm(VReg.S1, maxA);
            vm.jle(L + "_cok");
            vm.movImm(VReg.S1, maxA);
            vm.label(L + "_cok");
            // 逐位 ToNumber(生成器展开;count 连续,i>=count 直落调用,全位强转保序)。
            // 日历族(part 0..2):转 int 落槽;NaN/±Inf(指数全 1)或超 V8 MakeDay 原参界
            //   (|year|>1e6、|month|>1e7、|date|>1e9,fcmp 守 §1.2,与直调 SETTER_MAG_BITS
            //   同界)→ 置 [SP+80] 标志不短路,L_call 统一分流 _nan(写回 NaN,同 node)。
            // 时间族(part 3..6):f64 位直落槽(ToInteger/NaN/巨大值全由 _date_set_time_f64_t
            //   的 float 域组合自然处理,跨字段对消与 node 逐位一致),无需标志与门。
            const isTime = part >= 3;
            const CAL_MAG = [0x412e848000000000n, 0x416312d000000000n, 0x41cdcd6500000000n]; // 1e6/1e7/1e9
            if (!isTime) {
                vm.movImm(VReg.V0, 0);
                vm.store(VReg.SP, 80, VReg.V0); // argNaN = 0
            }
            for (let i = 0; i < maxA; i = i + 1) {
                vm.cmpImm(VReg.S1, i + 1);
                vm.jlt(L + "_call");
                vm.load(VReg.A0, VReg.SP, i * 8);
                vm.call("_number_coerce"); // RET = float64 位(先于任何用户 valueOf 读 argc)
                if (isTime) {
                    vm.store(VReg.SP, 40 + i * 8, VReg.RET); // f64 位直落槽
                } else {
                    vm.shrImm(VReg.V1, VReg.RET, 52);
                    vm.andImm(VReg.V1, VReg.V1, 0x7ff);
                    vm.cmpImm(VReg.V1, 0x7ff);
                    vm.jeq(L + "_argnan" + i); // NaN/±Inf
                    vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
                    vm.and(VReg.V1, VReg.RET, VReg.V1); // |v|(x64 V1==A3,循环内无活值)
                    vm.movImm64(VReg.V2, CAL_MAG[part + i]); // (x64 V2==A2,循环内无活值)
                    vm.fmovToFloat(0, VReg.V1);
                    vm.fmovToFloat(1, VReg.V2);
                    vm.fcmp(0, 1);
                    vm.jfgt(L + "_argnan" + i); // 超 V8 原参界
                    vm.jmp(L + "_argok" + i);
                    vm.label(L + "_argnan" + i);
                    vm.movImm(VReg.V1, 1);
                    vm.store(VReg.SP, 80, VReg.V1); // argNaN = 1(不跳出循环)
                    vm.label(L + "_argok" + i);
                    vm.fmovToFloat(0, VReg.RET);
                    vm.fcvtzs(VReg.V0, 0); // 向零截断(NaN→0;标志命中时槽值不被使用)
                    vm.store(VReg.SP, 40 + i * 8, VReg.V0);
                }
                if (part === 0 && i === 0) {
                    // setFullYear:V8 于 year 强转后读 t(见上)
                    vm.load(VReg.V0, VReg.S0, 8);
                    vm.store(VReg.SP, 72, VReg.V0);
                }
            }
            vm.label(L + "_call");
            vm.cmpImm(VReg.S2, 1);
            vm.jeq(L + "_nan"); // 强转前已 Invalid → 由 _nan 分流到不写回支路
            if (!isTime) {
                vm.load(VReg.V0, VReg.SP, 80);
                vm.cmpImm(VReg.V0, 0);
                vm.jne(L + "_nan"); // 任一位 NaN/±Inf → 写回 NaN(全部强转已完成)
            }
            vm.mov(VReg.A0, VReg.S0);
            vm.movImm(VReg.A1, part);
            vm.mov(VReg.A2, VReg.S1);
            vm.addImm(VReg.A3, VReg.SP, 40); // valuesPtr
            vm.load(VReg.A4, VReg.SP, 72);   // t(读取时点按 part 分流,见上)
            if (isTime) {
                vm.call("_date_set_time_f64_t"); // float 域组合(RET = number)
            } else {
                vm.call("_date_set_parts_t");  // RET = 新 ms(裸 float 位 = number)
            }
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 96);
            vm.label(L + "_nan");
            // 强转得 NaN(t 有效)→ 规范写回 NaN;强转前已 Invalid(S2=1)→ 规范只
            // return NaN,【不写】[[DateValue]](valueOf 副作用对时间戳的修复必须保留)。
            vm.cmpImm(VReg.S2, 1);
            vm.jeq(L + "_inv");
            vm.movImm64(VReg.RET, 0x7ff0000000000001n); // 非别名 NaN(同 _dp_invalid)
            vm.store(VReg.S0, 8, VReg.RET);
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 96);
            vm.label(L + "_inv");
            vm.movImm64(VReg.RET, 0x7ff0000000000001n);
            vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 96);
        }

        // setTime wrapper:ToNumber 实参 + TimeClip(NaN/±Inf 或 |v|>8.64e15 → Invalid Date
        // 写 NaN 返回 NaN),否则向零截断写回 timestamp 并返回新 ms(number)。
        vm.label("_aref_date_setTime");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1);                  // 装箱新 ms
        vm.lea(VReg.A1, vm.asm.addString("setTime"));
        vm.call("_date_this_named");               // RET = 裸 date 指针
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_number_coerce");                 // RET = ToNumber 的 float64 位
        vm.shrImm(VReg.V1, VReg.RET, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7ff);
        vm.cmpImm(VReg.V1, 0x7ff);
        vm.jeq("_aref_date_setTime_nan");
        // |v| > 8.64e15 → Invalid(fcmp 比较,守 §1.2 不用整数比 float 位)
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V2, VReg.RET, VReg.V1);        // V2 = |v| 位(x64 V2==A2,A2 无活值)
        vm.movImm64(VReg.V1, 0x433eb208c2dc0000n); // 8.64e15
        vm.fmovToFloat(0, VReg.V2);
        vm.fmovToFloat(1, VReg.V1);
        vm.fcmp(0, 1);
        vm.jfgt("_aref_date_setTime_nan");
        vm.fmovToFloat(0, VReg.RET);
        vm.fcvtzs(VReg.V2, 0);                     // 向零截断
        vm.scvtf(0, VReg.V2);
        vm.fmovToInt(VReg.RET, 0);
        vm.store(VReg.S0, 8, VReg.RET);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_aref_date_setTime_nan");
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.store(VReg.S0, 8, VReg.RET);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // getTimezoneOffset wrapper:本运行时全 UTC,恒返回装箱 0(同 compileDateMethod)。
        // [Date 加固] 仍先校验接收者(非 Date 抛 TypeError,与 node 一致)。
        vm.label("_aref_date_tzoffset");
        vm.prologue(0, []);
        vm.call("_date_this_get"); // 仅校验(this 丢弃;非 Date 不返回)
        vm.movImm(VReg.RET, 0);
        vm.scvtf(0, VReg.RET);
        vm.fmovToInt(VReg.RET, 0);
        vm.epilogue([], 0);

        // ── [Date 加固] this 校验族 ────────────────────────────────────────────
        // _date_this_ptr(A0=装箱 0x7ffd 或裸堆指针)→ RET=裸 Date 指针;否则 RET=0。
        // 裸指针先验堆界再读类型字节(小整数/浮点载荷绝不解引用)。
        vm.label("_date_this_ptr");
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_dtp_boxed");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_dtp_no");
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jlt("_dtp_no");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jge("_dtp_no");
        vm.mov(VReg.RET, VReg.A0);
        vm.jmp("_dtp_type");
        vm.label("_dtp_boxed");
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.A0, VReg.V1);
        vm.label("_dtp_type");
        vm.loadByte(VReg.V1, VReg.RET, 0);
        vm.cmpImm(VReg.V1, 7); // TYPE_DATE
        vm.jne("_dtp_no");
        vm.ret();
        vm.label("_dtp_no");
        vm.movImm(VReg.RET, 0);
        vm.ret();

        // _date_this_get(A0=接收者)→ RET=裸 Date 指针;非 Date 抛 TypeError
        // "this is not a Date object."(getter 族 V8 文案,逐字;不返回)。
        vm.label("_date_this_get");
        vm.prologue(0, []);
        vm.call("_date_this_ptr");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_dtg_ok");
        vm.lea(VReg.A0, vm.asm.addString("this is not a Date object."));
        vm.call("_cstr_to_heap_str");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error"); // 不返回
        vm.label("_dtg_ok");
        vm.epilogue([], 0);

        // _date_this_named(A0=接收者, A1=方法名 cstr)→ RET=裸 Date 指针;非 Date 按
        // V8 文案抛 TypeError "Method Date.prototype.<name> called on incompatible
        // receiver <desc>"(desc 见 _date_recv_desc;不返回)。
        vm.label("_date_this_named");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // recv
        vm.mov(VReg.S1, VReg.A1); // name cstr
        vm.call("_date_this_ptr");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_dtn_bad");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dtn_bad");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_date_recv_desc"); // RET = 接收者描述(装箱串)
        vm.mov(VReg.S2, VReg.RET);
        vm.lea(VReg.A0, vm.asm.addString("Method Date.prototype."));
        vm.call("_cstr_to_heap_str");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1); // name cstr → 装箱(同 _throw_read_nullish 的 boxStr 式)
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_strconcat");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, vm.asm.addString(" called on incompatible receiver "));
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_strconcat");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_strconcat");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0); // 理论不达

        // _date_recv_desc(A0=接收者)→ RET=V8 "incompatible receiver" 消息里的接收者
        // 描述(装箱串):null/undefined/true/false/字符串本体/"#<Object>"(plain 对象)/
        // "[object Array]"/"Symbol()"/数字 ToString;函数无法复现源码文本 → "#<Function>"
        // (记偏差),Object.create(Date.prototype) 等原型形态无法区分 → "#<Object>"(记偏差)。
        vm.label("_date_recv_desc");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFA);
        vm.jne("_drd_n1");
        vm.lea(VReg.A0, vm.asm.addString("null"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_n1");
        vm.cmpImm(VReg.V1, 0x7FFB);
        vm.jne("_drd_n2");
        vm.lea(VReg.A0, vm.asm.addString("undefined"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_n2");
        vm.cmpImm(VReg.V1, 0x7FF9);
        vm.jne("_drd_n3");
        vm.movImm64(VReg.V1, 0x7ff9000000000001n); // JS_TRUE
        vm.cmp(VReg.S0, VReg.V1);
        vm.jne("_drd_false");
        vm.lea(VReg.A0, vm.asm.addString("true"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_false");
        vm.lea(VReg.A0, vm.asm.addString("false"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_n3");
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jne("_drd_n4");
        vm.mov(VReg.RET, VReg.S0); // 字符串接收者:消息嵌本体
        vm.epilogue([VReg.S0], 0);
        vm.label("_drd_n4");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jne("_drd_n5");
        vm.lea(VReg.A0, vm.asm.addString("[object Array]"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_n5");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_drd_n6");
        vm.lea(VReg.A0, vm.asm.addString("#<Object>"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_n6");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jne("_drd_n7");
        vm.lea(VReg.A0, vm.asm.addString("#<Function>"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_n7");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_drd_num");
        // 裸指针:堆内且类型字节 61(TYPE_SYMBOL)→ "Symbol()";其余 "#<Object>"
        vm.lea(VReg.V1, "_heap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jlt("_drd_obj");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_drd_obj");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 61);
        vm.jne("_drd_obj");
        vm.lea(VReg.A0, vm.asm.addString("Symbol()"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_obj");
        vm.lea(VReg.A0, vm.asm.addString("#<Object>"));
        vm.jmp("_drd_cstr");
        vm.label("_drd_num");
        // 数字(装箱 int32 0x7FF8 / float64 位)→ ToString("42"/"2.5"/"NaN")
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_valueToStr");
        vm.epilogue([VReg.S0], 0);
        vm.label("_drd_cstr");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.RET, VReg.A0, VReg.V1);
        vm.epilogue([VReg.S0], 0);

        // _date_write_num_rev(A0=目标地址, A1=值(≥0), A2=位数)→ 十进制右起写入,
        // 自带前导零(年字段用:4/6 位定宽与 >4 位变长同一形态,免复制大段 padded 族)。
        // 叶子;V3=10,V4=地址,V5=数字位,镜像 _write_int_padded_* 的 div/mod 寄存器分工。
        vm.label("_date_write_num_rev");
        vm.movImm(VReg.V3, 10);
        vm.label("_dwnr_loop");
        vm.cmpImm(VReg.A2, 0);
        vm.jle("_dwnr_done");
        vm.subImm(VReg.A2, VReg.A2, 1);
        vm.add(VReg.V4, VReg.A0, VReg.A2); // &pos[i]
        vm.mod(VReg.V5, VReg.A1, VReg.V3); // 个位
        vm.addImm(VReg.V5, VReg.V5, 48);   // +'0'
        vm.storeByte(VReg.V4, 0, VReg.V5);
        vm.div(VReg.A1, VReg.A1, VReg.V3);
        vm.jmp("_dwnr_loop");
        vm.label("_dwnr_done");
        vm.ret();
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

        // [Date 加固] this 检查:原型方法 .call({}) 等非 Date 接收者按 V8 文案抛
        // TypeError,不再无防护读 [this+8]。直调/打印/JSON 桥路径传入的都是真 Date,直通。
        vm.lea(VReg.A1, vm.asm.addString("toISOString"));
        vm.call("_date_this_named"); // RET = 裸 date 指针(非 Date 不返回)
        // 经 _date_get_part 逐字段拆解(UTC 语义,负 ms/1970 前正确;旧浮点分解对负
        // 时间戳产生负字段 → toISOString 输出乱码)。get_part 会破坏 S3-S5,故全部经栈中转。
        // 栈: [0]ms [8]sec [16]min [24]hour [32]strptr [40]date [48]year [56]month(1基) [64]day
        vm.store(VReg.SP, 40, VReg.RET); // date(裸指针,get_part 脱壳兼容)
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

        // 写入年:[0,9999] 4 位到 [RET+16..RET+19];界外(负年/>9999)按 ES 扩展形
        // ±YYYYYY(符号+6 位前导零)——尾部先按 4 位布局写、在下方统一后移 3 字节,
        // 符号与 6 位年数字在最后才写入(避免被原位尾部覆盖),长度 24→27。
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_diso_year_done");
        vm.cmpImm(VReg.S3, 9999);
        vm.jgt("_diso_year_done");
        vm.load(VReg.S0, VReg.SP, 32); // 重新加载字符串指针
        vm.addImm(VReg.S0, VReg.S0, 16); // S0 = 内容起始地址
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3); // year
        vm.call("_write_int_padded_4");
        vm.label("_diso_year_done");

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

        // ±YYYYYY 扩展年:尾部(block[20..40],含 NUL)后移 3 字节腾出年字段位,
        // 再写符号 @16 与 6 位前导零 @17..22,长度 24→27(分配 48 不变:16+27+1=44 仍容纳)。
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_diso_shift");
        vm.cmpImm(VReg.S3, 9999);
        vm.jle("_diso_shift_done");
        vm.label("_diso_shift");
        vm.load(VReg.S0, VReg.SP, 32);
        vm.movImm(VReg.V3, 41);
        vm.label("_diso_shift_loop");
        vm.subImm(VReg.V3, VReg.V3, 1);
        vm.add(VReg.V4, VReg.S0, VReg.V3);   // &block[i](x64 add 内部 scratch 为 V5/V6,之后方用 V5)
        vm.loadByte(VReg.V5, VReg.V4, 0);
        vm.storeByte(VReg.V4, 3, VReg.V5);
        vm.cmpImm(VReg.V3, 20);
        vm.jgt("_diso_shift_loop");
        // 符号 @16('-'=45 / '+'=43)
        vm.movImm(VReg.V0, 43);
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_diso_ext_pos");
        vm.movImm(VReg.V0, 45);
        vm.label("_diso_ext_pos");
        vm.storeByte(VReg.S0, 16, VReg.V0);
        // |year| 6 位前导零 @17..22
        vm.mov(VReg.A1, VReg.S3);
        vm.cmpImm(VReg.S3, 0);
        vm.jge("_diso_ext_abs");
        vm.mov(VReg.V2, VReg.A1);
        vm.movImm(VReg.A1, 0);
        vm.sub(VReg.A1, VReg.A1, VReg.V2); // x64 V2==A2,此后才装 A2
        vm.label("_diso_ext_abs");
        vm.addImm(VReg.A0, VReg.S0, 17);
        vm.movImm(VReg.A2, 6);
        vm.call("_date_write_num_rev");
        vm.load(VReg.S0, VReg.SP, 32); // _date_write_num_rev 叶子不毁 S0,防御性重载亦无妨
        vm.movImm(VReg.V0, 27);
        vm.store(VReg.S0, 8, VReg.V0);
        vm.label("_diso_shift_done");

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
        // [Date 加固] 薄壳拆分:本体读当前 [[DateValue]] 后尾跳共享体 _dgp_ts_body;
        // _date_get_part_ts(A0=ts float64 位) 供"强转前预读 t"的 setter 从旧 t 拆字段。
        vm.label("_date_get_part");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A1); // part
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.A0, VReg.V1); // 裸 date 指针
        vm.load(VReg.A0, VReg.S0, 8); // ts(float64 位)→ A0
        vm.jmp("_dgp_ts_body");
        vm.label("_date_get_part_ts");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A1); // part
        vm.label("_dgp_ts_body");
        vm.fmovToFloat(0, VReg.A0); // A0=V0 同寄存器,与原直读 V0 等价
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
        // [Date 加固] 负年修正:编码值 y*10000+m*100+d 中 m*100+d∈[101,1231] 恒正,
        // 截断除对负年向上进 1(如 -1 年 7 月 → -9298/10000=0),须 floor:余<0 则商-1。
        vm.mod(VReg.V0, VReg.S2, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_dgp_year_ok");
        vm.subImm(VReg.RET, VReg.RET, 1);
        vm.label("_dgp_year_ok");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_notyear");
        vm.cmpImm(VReg.S1, 1);
        vm.jne("_dgp_day");
        // [Date 加固] 负年同理:y*100+m 取 floor(截断商余<0 则 -1),m 取正余(<0 则 +100)。
        vm.movImm(VReg.V1, 100);
        vm.div(VReg.V0, VReg.S2, VReg.V1); // y*100+m
        vm.mod(VReg.V2, VReg.S2, VReg.V1);
        vm.cmpImm(VReg.V2, 0);
        vm.jge("_dgp_mon_fok");
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.label("_dgp_mon_fok");
        vm.movImm(VReg.V1, 100);
        vm.mod(VReg.RET, VReg.V0, VReg.V1); // m(1基)
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_dgp_mon_ok");
        vm.addImm(VReg.RET, VReg.RET, 100);
        vm.label("_dgp_mon_ok");
        vm.subImm(VReg.RET, VReg.RET, 1);   // 0 基
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_day");
        vm.movImm(VReg.V1, 100);
        vm.mod(VReg.RET, VReg.S2, VReg.V1);
        // [Date 加固] 负年日取正余(<0 则 +100)
        vm.cmpImm(VReg.RET, 0);
        vm.jge("_dgp_day_ok");
        vm.addImm(VReg.RET, VReg.RET, 100);
        vm.label("_dgp_day_ok");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_dgp_dow");
        // 1970-01-01 是周四(4):dow = (floor(ms/86400000)+4)%7
        // [Date 加固] 负 ms 截断除须 floor 修正(同 _dgp_days_ok 形;epoch-1ms 是周三,
        // 截断得 0 天会误报周四)。x64 V2==A2,此处 A2 无活值。
        vm.movImm(VReg.V1, 86400000);
        vm.div(VReg.V0, VReg.S0, VReg.V1);
        vm.mod(VReg.V2, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V2, 0);
        vm.jge("_dgp_dow_fok");
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.label("_dgp_dow_fok");
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
        // [Date 加固] 扩展年份 ±YYYYYY:首字符 '+'/'-' → 6 位年在此单独解析(带符号),
        // 随后指针+3/长度-3,下方标准路径(分隔符/月/日/时间偏移)原样复用。
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, 45); // '-'
        vm.jeq("_dp_ext_year");
        vm.cmpImm(VReg.V0, 43); // '+'
        vm.jeq("_dp_ext_year");
        vm.jmp("_dp_std_year");
        vm.label("_dp_ext_year");
        vm.addImm(VReg.A0, VReg.S1, 1);
        vm.movImm(VReg.A1, 6);
        vm.call("_date_num");
        vm.cmpImm(VReg.RET, 0);
        vm.jlt("_dp_invalid");
        vm.loadByte(VReg.V0, VReg.S1, 0);
        vm.cmpImm(VReg.V0, 45);
        vm.jne("_dp_ext_pos");
        // 负号且值为 0("-000000")非法(ES 扩展年 -0 无效,同 node;test262 parse/year-zero)
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_dp_invalid");
        vm.movImm(VReg.V1, 0);
        vm.sub(VReg.V1, VReg.V1, VReg.RET); // dest==a 形态,避开 RET 别名
        vm.mov(VReg.RET, VReg.V1);
        vm.label("_dp_ext_pos");
        vm.mov(VReg.S2, VReg.RET); // year(带符号)
        vm.addImm(VReg.S1, VReg.S1, 3);
        vm.subImm(VReg.S5, VReg.S5, 3);
        vm.jmp("_dp_month");
        vm.label("_dp_std_year");
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
        vm.label("_dp_month"); // 扩展年路径在此并入(S2 已备,S1/S5 已 +3/-3)
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
        // [Date 加固] TimeClip:|ms| > 8.64e15 → Invalid Date(写 NaN 返 NaN;
        // 整数比较——V5 是真整数毫秒,非 float 位序,不触 §1.2)
        vm.movImm64(VReg.V1, 8640000000000000n);
        vm.cmp(VReg.V5, VReg.V1);
        vm.jgt("_dsp_clipnan");
        vm.movImm64(VReg.V1, -8640000000000000n);
        vm.cmp(VReg.V5, VReg.V1);
        vm.jlt("_dsp_clipnan");
        // 写回 & 返回
        vm.scvtf(0, VReg.V5);
        vm.fmovToInt(VReg.V3, 0); // 新 ms 的 float 位
        vm.load(VReg.V4, VReg.SP, 56);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V4, VReg.V4, VReg.V1);
        vm.store(VReg.V4, 8, VReg.V3);
        vm.mov(VReg.RET, VReg.V3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 128);
        vm.label("_dsp_clipnan");
        vm.movImm64(VReg.V3, 0x7ff0000000000001n);
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
        //     [56]boxed date [64]startPart [72]count [80]valuesPtr [88]预读 ts
        // [Date 加固] 薄壳:读当前 [[DateValue]] → A4 尾跳 _date_set_parts_t(编译器直调
        // 快路语义不变,仍是"调用时"的时间戳);aref wrapper 以"强转前预读 t"作 A4 调
        // _date_set_parts_t(ES:t 先于 ToNumber 读取)。
        // 注意 x64:V1==RCX==A3,emitMaskLoad(V1) 会冲掉 A3(valuesPtr),故手写 mask 到 V3。
        vm.label("_date_set_parts");
        vm.movImm64(VReg.V3, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.A0, VReg.V3);
        vm.load(VReg.A4, VReg.V0, 8);
        vm.jmp("_date_set_parts_t");
        vm.label("_date_set_parts_t");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.store(VReg.SP, 56, VReg.A0);
        vm.store(VReg.SP, 64, VReg.A1);
        vm.store(VReg.SP, 72, VReg.A2);
        vm.store(VReg.SP, 80, VReg.A3);
        vm.store(VReg.SP, 88, VReg.A4); // 时间戳(float64 位;调用方语义决定"当前"或"预读")
        // 采集现字段(从 ts 拆;get_part_ts: 0..5;7=ms → 槽 6)
        vm.load(VReg.A0, VReg.SP, 88); vm.movImm(VReg.A1, 0); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 0, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 88); vm.movImm(VReg.A1, 1); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 88); vm.movImm(VReg.A1, 2); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 16, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 88); vm.movImm(VReg.A1, 3); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 24, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 88); vm.movImm(VReg.A1, 4); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 32, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 88); vm.movImm(VReg.A1, 5); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 40, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 88); vm.movImm(VReg.A1, 7); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 48, VReg.RET);
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
        // [Date 加固] TimeClip:|ms| > 8.64e15 → Invalid Date(同 _date_set_part)
        vm.movImm64(VReg.V1, 8640000000000000n);
        vm.cmp(VReg.V5, VReg.V1);
        vm.jgt("_dsps_clipnan");
        vm.movImm64(VReg.V1, -8640000000000000n);
        vm.cmp(VReg.V5, VReg.V1);
        vm.jlt("_dsps_clipnan");
        // 写回 & 返回
        vm.scvtf(0, VReg.V5);
        vm.fmovToInt(VReg.V3, 0);
        vm.load(VReg.V4, VReg.SP, 56);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V4, VReg.V4, VReg.V1);
        vm.store(VReg.V4, 8, VReg.V3);
        vm.mov(VReg.RET, VReg.V3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);
        vm.label("_dsps_clipnan");
        vm.movImm64(VReg.V3, 0x7ff0000000000001n);
        vm.load(VReg.V4, VReg.SP, 56);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V4, VReg.V4, VReg.V1);
        vm.store(VReg.V4, 8, VReg.V3);
        vm.mov(VReg.RET, VReg.V3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 128);

        // _fma_emu(A0=x 位, A1=c 位, A2=Kodd 位, A3=2^shift 位) -> RET = fl(x×(Kodd·2^shift) + c)
        // [Date 加固] 无 fma 指令平台的 fma 仿真:复现 V8 MakeTime 的编译器收缩
        // (h*3600000 精确入加、m*60000 先舍入——v8/src/date/date.cc MakeTime 经 clang
        // contraction;实测残差 167772160=−δ(fl(3.6e24)) 等 5 例逐位吻合)。
        // 结构:Dekker twoProd(x, Kodd)(Veltkamp 分裂,分裂常数 2^27+1)→ P+E = x×K 精确;
        // twoSum(P, c) → s+u;result = fl(s + (u+E))(Boldo/Muller 仿真,舍入一次)。
        // 巨大值支路:|x| ≥ 2^990(fcmp,守 §1.2)时分裂会溢出——查尾数:积精确
        // (M 低 15 位全 0,或低 14 位全 0 且 M < 2^67/28125)则 E=0 直走;否则 δ≠0 且
        // |δ| ≥ 2^937 ≫ 8.64e15 → 直接 NaN(超出验收矩阵 ~1e292 覆盖,记档)。
        // FP 寄存器:D0=x D1=c D5=2^shift D6=Kodd D2/D3/D4/D7 暂存。
        vm.label("_fma_emu");
        vm.prologue(0, []);
        vm.fmovToFloat(0, VReg.A0);
        vm.fmovToFloat(1, VReg.A1);
        vm.fmovToFloat(6, VReg.A2);
        vm.fmovToFloat(5, VReg.A3);
        // |x| ≥ 2^990 → 巨大支路(V0==A0==RET 别名:掩码先落 V1,and 的 dest==src1 合法)
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V0, VReg.A0, VReg.V1); // V0 = |x| 位
        vm.movImm64(VReg.V1, 0x7dd0000000000000n); // 2^990
        vm.fmovToFloat(2, VReg.V0);
        vm.fmovToFloat(3, VReg.V1);
        vm.fcmp(2, 3);
        vm.jfge("_fma_emu_huge");
        // Veltkamp 分裂 x(分裂常数 134217729 = 2^27+1)
        vm.movImm64(VReg.V0, 0x41a0000002000000n); // 134217729.0
        vm.fmovToFloat(2, VReg.V0);
        vm.fmul(2, 0, 2);   // D2 = xs
        vm.fsub(3, 2, 0);   // D3 = xs - x
        vm.fsub(3, 2, 3);   // D3 = xh
        vm.fsub(4, 0, 3);   // D4 = xl
        // Dekker 误差:e0 = (xh×Kodd - p0) + xl×Kodd(Kodd < 2^27,高低直取)
        vm.fmul(7, 0, 6);   // D7 = p0 = x×Kodd(舍入)
        vm.fmul(2, 3, 6);   // D2 = xh×Kodd
        vm.fsub(2, 2, 7);   // D2 = xh×Kodd - p0(精确)
        vm.fmul(3, 4, 6);   // D3 = xl×Kodd
        vm.fadd(2, 2, 3);   // D2 = e0
        // 缩放:P = p0×2^shift、E = e0×2^shift(2 的幂乘法精确)
        vm.fmul(7, 7, 5);   // D7 = P
        vm.fmul(2, 2, 5);   // D2 = E
        vm.jmp("_fma_emu_sum");
        vm.label("_fma_emu_exact");
        // 积精确:P 直接取,E = +0
        vm.fmul(7, 0, 6);   // D7 = x×Kodd(精确)
        vm.fmul(7, 7, 5);   // D7 = P
        vm.fsub(2, 7, 7);   // D2 = +0.0
        vm.label("_fma_emu_sum");
        // twoSum(P=D7, c=D1):s = P+c;u = (P - (s - (s - P))) + (c - (s - P))
        vm.fadd(3, 7, 1);   // D3 = s
        vm.fsub(4, 3, 7);   // D4 = bp = s - P
        vm.fsub(5, 3, 4);   // D5 = ap = s - bp
        vm.fsub(5, 7, 5);   // D5 = P - ap
        vm.fsub(4, 1, 4);   // D4 = c - bp
        vm.fadd(5, 5, 4);   // D5 = u
        vm.fadd(2, 5, 2);   // D2 = u + E
        vm.fadd(3, 3, 2);   // D3 = fl(s + (u+E))
        vm.fmovToInt(VReg.RET, 3);
        vm.epilogue([], 0);
        vm.label("_fma_emu_huge");
        // M = (bits & 0xfffffffffffff) | 2^52(正规数;调用方保证 x 整数值/Inf,非次正规)
        // (V0==A0 别名:掩码先落 V1,and 的 dest==src1 合法)
        vm.movImm64(VReg.V1, 0xfffffffffffffn);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, 0x10000000000000n);
        vm.or(VReg.V0, VReg.V0, VReg.V1); // M(≤2^53,int64 安全)
        // (M & 32767)==0 → 积精确
        vm.movImm(VReg.V1, 32767);
        vm.and(VReg.V1, VReg.V0, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_fma_emu_exact");
        // (M & 16383)==0 且 M < 2^67/28125(=5247087198758.28…取整 5247087198758)→ 精确
        vm.movImm(VReg.V1, 16383);
        vm.and(VReg.V1, VReg.V0, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_fma_emu_nan");
        vm.movImm64(VReg.V1, 5247087198758n);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_fma_emu_exact");
        vm.label("_fma_emu_nan");
        vm.movImm64(VReg.RET, 0x7ff0000000000001n); // canonical NaN(同 _dp_invalid)
        vm.epilogue([], 0);

        // _date_set_time_f64(A0=date, A1=startPart(3=h 4=mi 5=s 6=ms), A2=count,
        //                    A3=valuesPtr(逐参 f64 位)) -> 新 ms(number)
        // 薄壳:读当前 [[DateValue]] → A4 尾跳 _t(编译器直调"调用时"语义,同 _date_set_parts)。
        // [Date 加固] 时间族多字段 float 域组合(spec MakeTime/MakeDate/TimeClip 字面,
        // 复现 V8 FMA 收缩序——跨字段对消/巨大值全谱与 node 逐位一致):
        //   字段 h/mi/s/ms:实参覆盖位取槽值(逐参 ToInteger:指数全 1 或 |v|≥2^63 恒等,
        //   否则 fcvtzs+scvtf 往返);未覆盖位取 t 现字段(_date_get_part_ts → scvtf)。
        //   time = fma(h,3600000, mi×60000) → fma(s,1000, ·) → +ms(_fma_emu 仿真);
        //   day = floor(fcvtzs(t)/86400000)(int64,fcvtzs(NaN)=0 → 纪元,同 _date_set_parts);
        //   total = time + day×86400000(f64);TimeClip(指数全 1 或 |total|>8.64e15 →
        //   canonical NaN 写回并返回;否则 fcvtzs+scvtf 截断写回并返回)。
        // 栈:[0]date [8]startPart [16]count [24]valuesPtr [32]t [40..64]cur h/mi/s/ms(int)
        //     [72..96]field h/mi/s/ms(f64 位) [104]time 累积
        vm.label("_date_set_time_f64");
        vm.movImm64(VReg.V3, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.A0, VReg.V3);
        vm.load(VReg.A4, VReg.V0, 8);
        // fall through / jmp 到 _t
        vm.label("_date_set_time_f64_t");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.store(VReg.SP, 0, VReg.A0);
        vm.store(VReg.SP, 8, VReg.A1);
        vm.store(VReg.SP, 16, VReg.A2);
        vm.store(VReg.SP, 24, VReg.A3);
        vm.store(VReg.SP, 32, VReg.A4);
        vm.movImm64(VReg.V3, 0x0000ffffffffffffn);
        vm.and(VReg.S0, VReg.A0, VReg.V3); // S0 = 裸 date 指针
        // 提取现字段(_date_get_part_ts 毁 A 系;S0-S3 由其 prologue 自保)
        vm.load(VReg.A0, VReg.SP, 32); vm.movImm(VReg.A1, 3); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 40, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 32); vm.movImm(VReg.A1, 4); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 48, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 32); vm.movImm(VReg.A1, 5); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 56, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 32); vm.movImm(VReg.A1, 7); vm.call("_date_get_part_ts"); vm.store(VReg.SP, 64, VReg.RET);
        // 逐字段定值(生成器展开;SPART = 3+k)
        const SPART = [3, 4, 5, 6];
        for (let k = 0; k < 4; k = k + 1) {
            const useCur = "_dstf_cur" + k;
            const haveV = "_dstf_have" + k;
            // startPart ≤ pk ≤ startPart+count-1 → 实参槽
            vm.load(VReg.V0, VReg.SP, 8);
            vm.cmpImm(VReg.V0, SPART[k]);
            vm.jgt(useCur);
            vm.load(VReg.V1, VReg.SP, 16);
            vm.add(VReg.V0, VReg.V0, VReg.V1); // startPart+count
            vm.cmpImm(VReg.V0, SPART[k]);
            vm.jle(useCur);
            // idx = pk - startPart;v = values[idx](f64 位)
            vm.load(VReg.V1, VReg.SP, 8);
            vm.movImm(VReg.V2, SPART[k]);
            vm.sub(VReg.V1, VReg.V2, VReg.V1);
            vm.movImm(VReg.V2, 8);
            vm.mul(VReg.V1, VReg.V1, VReg.V2);
            vm.load(VReg.V2, VReg.SP, 24);
            vm.add(VReg.V1, VReg.V1, VReg.V2);
            vm.load(VReg.V0, VReg.V1, 0);
            // ToInteger:指数全 1 或 |v| ≥ 2^63(fcmp)恒等保留;否则 fcvtzs+scvtf 往返
            vm.shrImm(VReg.V1, VReg.V0, 52);
            vm.andImm(VReg.V1, VReg.V1, 0x7ff);
            vm.cmpImm(VReg.V1, 0x7ff);
            vm.jeq(haveV);
            vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
            vm.and(VReg.V1, VReg.V0, VReg.V1);
            vm.movImm64(VReg.V2, 0x43e0000000000000n); // 2^63
            vm.fmovToFloat(0, VReg.V1);
            vm.fmovToFloat(1, VReg.V2);
            vm.fcmp(0, 1);
            vm.jfge(haveV);
            vm.fmovToFloat(0, VReg.V0);
            vm.fcvtzs(VReg.V1, 0);
            vm.scvtf(0, VReg.V1);
            vm.fmovToInt(VReg.V0, 0);
            vm.jmp(haveV);
            vm.label(useCur);
            vm.load(VReg.V0, VReg.SP, 40 + k * 8);
            vm.scvtf(0, VReg.V0);
            vm.fmovToInt(VReg.V0, 0);
            vm.label(haveV);
            vm.store(VReg.SP, 72 + k * 8, VReg.V0);
        }
        // time = fma(h, 3600000, fl(mi×60000))(60000.0 = 0x40ed4c0000000000)
        vm.load(VReg.V0, VReg.SP, 80);
        vm.movImm64(VReg.V1, 0x40ed4c0000000000n);
        vm.fmovToFloat(0, VReg.V0);
        vm.fmovToFloat(1, VReg.V1);
        vm.fmul(0, 0, 1);
        vm.fmovToInt(VReg.A1, 0); // c = fl(mi×60000)
        vm.load(VReg.A0, VReg.SP, 72); // x = h
        vm.movImm64(VReg.A2, 0x40db774000000000n); // 28125.0(3600000 = 28125×2^7)
        vm.movImm64(VReg.A3, 0x4060000000000000n); // 128.0
        vm.call("_fma_emu");
        vm.store(VReg.SP, 104, VReg.RET); // time = s1
        // time = fma(s, 1000, s1)(1000 = 125×2^3)
        // 注意 RET==A0 别名(arm64 X0/wasm 全局 1 同语义):必须先 mov 走 s1 再载入 A0,
        // 否则 load A0 会把 RET 里的 s1 覆盖成 s(c 错取为 s → s×1001)。
        vm.mov(VReg.A1, VReg.RET);     // c = s1(先取)
        vm.load(VReg.A0, VReg.SP, 88); // x = s(后取)
        vm.movImm64(VReg.A2, 0x405f400000000000n); // 125.0
        vm.movImm64(VReg.A3, 0x4020000000000000n); // 8.0
        vm.call("_fma_emu");
        // time = fl(s2 + ms)
        vm.fmovToFloat(0, VReg.RET);
        vm.load(VReg.V1, VReg.SP, 96);
        vm.fmovToFloat(1, VReg.V1);
        vm.fadd(0, 0, 1);
        vm.fmovToInt(VReg.V0, 0); // V0 = time 位
        // day_ms = floor(fcvtzs(t)/86400000)×86400000(int64,精确;NaN→0 纪元)
        vm.load(VReg.S1, VReg.SP, 32);
        vm.fmovToFloat(1, VReg.S1);
        vm.fcvtzs(VReg.S1, 1); // t_int
        vm.movImm(VReg.S2, 86400000);
        vm.div(VReg.V3, VReg.S1, VReg.S2);
        vm.mod(VReg.V4, VReg.S1, VReg.S2);
        vm.cmpImm(VReg.V4, 0);
        vm.jge("_dstf_dayok");
        vm.subImm(VReg.V3, VReg.V3, 1);
        vm.label("_dstf_dayok");
        vm.mul(VReg.V3, VReg.V3, VReg.S2); // day_ms
        vm.scvtf(1, VReg.V3);
        vm.fmovToFloat(0, VReg.V0);
        vm.fadd(0, 0, 1); // total = time + day_ms(f64)
        vm.fmovToInt(VReg.V0, 0);
        // TimeClip:指数全 1 或 |total| > 8.64e15(fcmp,守 §1.2)→ canonical NaN
        vm.shrImm(VReg.V1, VReg.V0, 52);
        vm.andImm(VReg.V1, VReg.V1, 0x7ff);
        vm.cmpImm(VReg.V1, 0x7ff);
        vm.jeq("_dstf_nan");
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.and(VReg.V1, VReg.V0, VReg.V1);
        vm.movImm64(VReg.V2, 0x433eb208c2dc0000n); // 8.64e15
        vm.fmovToFloat(0, VReg.V1);
        vm.fmovToFloat(1, VReg.V2);
        vm.fcmp(0, 1);
        vm.jfgt("_dstf_nan");
        vm.fmovToFloat(0, VReg.V0);
        vm.fcvtzs(VReg.V1, 0); // 向零截断(-0→+0)
        vm.scvtf(0, VReg.V1);
        vm.fmovToInt(VReg.RET, 0);
        vm.store(VReg.S0, 8, VReg.RET);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 128);
        vm.label("_dstf_nan");
        vm.movImm64(VReg.RET, 0x7ff0000000000001n);
        vm.store(VReg.S0, 8, VReg.RET);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 128);

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
