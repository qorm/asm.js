// asm.js 统一内存分配器
// 使用 VirtualMachine 抽象，生成跨平台的 allocator 代码
//
// ==================== Go 风格三级分配架构 ====================
//
// ┌──────────────────────────────────────────────────────────────┐
// │  小对象分配器 (Size Classes)                                  │
// │  ┌─────────────────────────────────────────────────────────┐│
// │  │ class[0]: 8B   → [free] → [free] → NULL                ││
// │  │ class[1]: 16B  → [free] → NULL                         ││
// │  │ ...                                                     ││
// │  │ class[17]: 512B → NULL                                 ││
// │  └─────────────────────────────────────────────────────────┘│
// │  小对象 (<=512B)：从对应 size class 的空闲链表分配           │
// │  无锁快速路径，O(1) 分配                                     │
// ├──────────────────────────────────────────────────────────────┤
// │  大对象分配器 (Bump Allocator)                               │
// │  大对象 (>512B)：直接从堆末尾 bump 分配                      │
// │  GC 回收后通过 large_free 链表复用                           │
// ├──────────────────────────────────────────────────────────────┤
// │  堆 (Heap)                                                   │
// │  [..........分配区域..........][→ heap_ptr]                 │
// │  通过 mmap 动态扩展                                          │
// └──────────────────────────────────────────────────────────────┘

import { VReg } from "../../vm/registers.js";
import { JS_TRUE, JS_FALSE, JS_NULL, JS_UNDEFINED } from "./jsvalue.js";
// [M4] per-P mcache 布局(GOMAXPROCS>1 小对象 bump 走当前 M 的 P);仅 linux-arm64 发射。
import { P_MC_CUR, P_MC_END, P_SIZE, P_MAX, P_SAVED_SP, P_STACK_HI } from "./parallel_sched.js";

// ==================== 常量定义 ====================

// 对象类型 (统一类型常量，用于 GC 遍历)
export const TYPE_RAW = 0; // 原始数据，无引用
export const TYPE_ARRAY = 1; // 数组，包含引用
export const TYPE_OBJECT = 2; // 对象，包含引用
export const TYPE_CLOSURE = 3; // 闭包，包含引用
export const TYPE_MAP = 4;
export const TYPE_SET = 5;
export const TYPE_STRING = 6; // 字符串，无引用
export const TYPE_DATE = 7;
export const TYPE_REGEXP = 8;
export const TYPE_GENERATOR = 9;
export const TYPE_COROUTINE = 10;
export const TYPE_PROMISE = 11; // Promise，包含引用
// 注:与 types.js 对齐。ArrayBuffer 头 type 字节 = 12(_arraybuffer_new/print.js 皆用
// types.js 的 TYPE_ARRAY_BUFFER=12)。此前本处 =13 与 types.js 的 TYPE_NUMBER=13 撞、
// 且与真实 ArrayBuffer 对象类型字节(12)不符——是死常量(无处 import/使用),纠正以除雷。
// 真实 TypedArray 无单一 type 字节(是 0x40-0x61 区间,见 types.js),此通用别名保留仅
// 为兼容旧引用(同样无处使用)。
export const TYPE_TYPED_ARRAY = 12;
export const TYPE_ARRAY_BUFFER = 12;

// Number 子类型 (boxed 数字对象)
export const TYPE_INT8 = 20;
export const TYPE_INT16 = 21;
export const TYPE_INT32 = 22;
export const TYPE_INT64 = 23;
export const TYPE_UINT8 = 24;
export const TYPE_UINT16 = 25;
export const TYPE_UINT32 = 26;
export const TYPE_UINT64 = 27;
export const TYPE_FLOAT32 = 28;
export const TYPE_FLOAT64 = 29; // JavaScript 默认数字类型
export const TYPE_GETTER = 60; // getter 标记对象 {type@block+0, func@block+8}，属性读取时自动调用
export const TYPE_SYMBOL = 61; // Symbol 标记块 {type@user+0, desc串裸指针@user+8, 保留@user+16}，裸堆指针表示

// Number 子类型 (用于 TypedArray 元素类型)
export const NUM_INT8 = 0x10;
export const NUM_INT16 = 0x11;
export const NUM_INT32 = 0x12;
export const NUM_INT64 = 0x13;
export const NUM_UINT8 = 0x20;
export const NUM_UINT16 = 0x21;
export const NUM_UINT32 = 0x22;
export const NUM_UINT64 = 0x23;
export const NUM_FLOAT16 = 0x30;
export const NUM_FLOAT32 = 0x31;
export const NUM_FLOAT64 = 0x32;

// ==================== 堆配置（参考 Go runtime）====================
// 24GB 初始虚拟堆：mmap 保留虚存、按页惰性提交(小程序 RSS 仍很小)。自举无 GC、bump 分配不回收，
// 编译整个编译器累计分配 ~十几 GB，会触发堆增长(A 的 mmap 重定位)——大堆重定位路径有 bug、访问
// 未映射内存 → SIGBUS(138)。给足初始堆使自举全程不重定位，绕过该 bug。32GB 机器可容。
export const INITIAL_HEAP_SIZE = 28 * 1024 * 1024 * 1024; // 28GB：24GB 时自举填满→重定位(copy→2×瞬时>32GB)OOM；实际需求 ~25GB，给 28GB 使全程不重定位
export const HEAP_GROW_SIZE = 16 * 1024 * 1024;
export const MAX_HEAP_SIZE = 0; // 最大堆大小，0 = 无限制
export const GC_THRESHOLD_PERCENT = 75; // 使用率达到 75% 时触发 GC

// ==================== Go 风格 size classes ====================
// 分配时向上取整到最接近的 size class
export const SIZE_CLASSES = [
    8, // class 0
    16, // class 1
    24, // class 2
    32, // class 3
    48, // class 4
    64, // class 5
    80, // class 6
    96, // class 7
    112, // class 8
    128, // class 9
    160, // class 10
    192, // class 11
    224, // class 12
    256, // class 13
    320, // class 14
    384, // class 15
    448, // class 16
    512, // class 17
];
export const NUM_SIZE_CLASSES = 18;
export const MAX_SMALL_SIZE = 512; // 超过这个大小使用大对象分配器

// ---- span 页模型(#20 S1,Go 蓝本)----
// 小对象按 class 分 64KB 对齐 span,块 stride=classSize+16(保留 16B 头,兼容
// 字符串 type/len 在头内的契约与现行 sweep);页映射 1B/页:0=非 span、1..18=class+1。
// 收益:mark 对 span 页内任意(含内部)指针 O(1) 解析真块起始(替代 startmap 回扫),
// 类内聚改善局部性。gap/span 尾余用「class=63 哨兵填充块」保持 sweep 线性行走同步。
export const SPAN_SIZE = 65536;
export const SPAN_SHIFT = 16;
export const SPAN_SENTINEL_CLASS = 63; // 头 class 位哨兵:footprint=size+16,永不挂链
// 每 class 的 span 可用字节(n×stride):保证尾余 ==0 或 ≥16(哨兵头可写)
export const SPAN_USABLE = SIZE_CLASSES.map((sz) => {
    const stride = sz + 16;
    let n = Math.floor(SPAN_SIZE / stride);
    const rem = SPAN_SIZE - n * stride;
    if (rem > 0 && rem < 16) n -= 1;
    return n * stride;
});

// 内存对齐
export const ALIGNMENT = 8;

// ==================== 堆元数据结构 ====================
//
// _heap_meta 布局（在数据段）:
//   offset 0:   heap_base      - 堆起始地址
//   offset 8:   heap_size      - 当前堆总大小
//   offset 16:  heap_used      - 已使用字节数
//   offset 24:  gc_running     - GC 是否正在运行
//   offset 32:  free_lists[18] - size class 空闲链表头指针 (18 * 8 = 144 bytes)
//   offset 176: large_free     - 大对象空闲链表
//   offset 184: gc_count       - GC 执行次数
//   offset 192: alloc_count    - 总分配次数
//   offset 200: (reserved)

export const META_HEAP_BASE = 0;
export const META_HEAP_SIZE = 8;
export const META_HEAP_USED = 16;
export const META_GC_RUNNING = 24;
export const META_FREE_LISTS = 32; // 18 * 8 = 144 bytes
export const META_LARGE_FREE = 176;
export const META_GC_COUNT = 184;
export const META_ALLOC_COUNT = 192;
export const META_HEAP_PEAK = 200; // heap_used 历史峰值(诊断;bump 增长点维护)
export const META_SIZE = 256; // 预留元数据空间

// ==================== per-M 上下文结构(M2 / G-M-P)====================
//
// docs/PARALLEL_DESIGN.md §3.3。每个 OS 线程(M)一块;GOMAXPROCS=1 下唯一静态
// 实例 `_m0_context`,在 _start 绑定到保留的 P/M 寄存器(arm64=x28)。§1.2 D 组的
// 线程执行状态槽逐类搬进此结构 → 第二个 M 起跑前拥有本地执行态。
//
// 放在 GC 根扫描区内(非 _heap_meta 跳过区):迁入的 exception_value / scheduler_current
// 等槽持有活 JS 值/协程指针,必须当根扫描。未迁移的槽恒 0(is_heap_ptr(0)=false,无害)。
//
// 寻址:arm64 后端把对特定标签(_exception_pending 等)的 lea 重定向为 [x28+OFF]
// (backend/arm64.js);x64/wasm 无空闲寄存器,暂留原全局数据标签(段寄存器 TLS 为后续)。
// 两架构在各自 GOMAXPROCS=1 语义下均正确。
export const MCTX_SELF = 0;          // OS tid / self
export const MCTX_CUR_STACK_LO = 8;  // 当前执行栈下界(GC 扫描起点候选,M5)
export const MCTX_CUR_STACK_HI = 16; // 当前执行栈上界(主栈=stack_base / coro 栈块顶)
export const MCTX_SCHED_CURRENT = 24;
export const MCTX_SCHED_MAIN = 32;
export const MCTX_CALL_ARGC = 40;
export const MCTX_EXC_PENDING = 48;
export const MCTX_EXC_VALUE = 56;
export const MCTX_EXC_CTX_TOP = 64;
export const MCTX_CALL_STACK_TOP = 72;
export const MCTX_CALL_STACK = 80;
export const MCTX_PARSE_LENIENT = 88;
export const MCTX_PRINT_BUF = 96;
export const MCTX_GEN_LAST_CORO = 104;
export const MCTX_P = 112;            // 挂接的 P 指针
export const MCTX_SIZE = 256;         // 预留(headroom)

// ==================== 对象头结构 ====================
//
// 16字节头布局:
//   offset 0 (qword):  flags_and_size
//                      bits 0-1:  mark (WHITE/GRAY/BLACK)
//                      bits 2-5:  type
//                      bits 6-9:  size_class (0-17, 15=large object)
//                      bits 16-63: size (bytes, 用户请求大小)
//   offset 8 (qword):  next_free (指针，仅空闲块使用)

export const HEADER_SIZE = 16;
export const HDR_FLAGS_SIZE = 0;
export const HDR_NEXT = 8;

// ==================== GC 配置 ====================
// 保守式 mark-sweep GC。标记阶段使用一段独立 mmap 的显式标记栈（gray 队列），
// 避免深递归爆native栈，并且标记阶段绝不分配。
export const GC_MARK_STACK_SIZE = 1 * 1024 * 1024 * 1024; // 1GB 保留虚存，惰性提交（实际 RSS = 峰值栈深）
export const GC_MIN_THRESHOLD = 4 * 1024 * 1024 * 1024; // 距上次 GC 分配满 256MB 前不 GC（小程序永不触发 GC）
// 标记位图：每 8 字节堆空间 1 bit。mark 位放独立位图而非对象头——保守扫描的误判指针
// 只会在位图里点亮一个无害的位（sweep 只读真实块起点对应的位，误判位从不被读），
// 绝不会把 mark 位或运进活对象的指针字段造成 +0x8000 腐蚀（这是把 mark 存头部会踩的坑）。
export const GC_BITMAP_SIZE = Math.floor(INITIAL_HEAP_SIZE / 64); // 每 64 字节堆 → 1 字节位图

// 头中的位域操作
export const MARK_MASK = 0x3; // bits 0-1（历史遗留；GC 用独立位图标记，不动对象头）
export const TYPE_SHIFT = 2;
export const TYPE_MASK = 0xf;
export const CLASS_SHIFT = 6;
export const CLASS_MASK = 0xf;
export const SIZE_SHIFT = 16;
export const LARGE_CLASS = 15; // 大对象标记

// 系统调用号
// macOS x64 系统调用需要加 0x2000000 偏移
// macOS ARM64 不需要加偏移
export const Syscall = {
    LINUX_MMAP: 9,
    LINUX_MMAP_ARM64: 222,
    MACOS_MMAP_ARM64: 197,
    MACOS_MMAP_X64: 0x20000c5, // 197 + 0x2000000
    LINUX_MUNMAP: 11,
    LINUX_MUNMAP_ARM64: 215,
    MACOS_MUNMAP_ARM64: 73,
    MACOS_MUNMAP_X64: 0x2000049, // 73 + 0x2000000
    LINUX_EXIT: 60,
    LINUX_EXIT_ARM64: 93,
    MACOS_EXIT_ARM64: 1,
    MACOS_EXIT_X64: 0x2000001, // 1 + 0x2000000
    LINUX_WRITE: 1,
    LINUX_WRITE_ARM64: 64,
    MACOS_WRITE_ARM64: 4,
    MACOS_WRITE_X64: 0x2000004, // 4 + 0x2000000
};

// ==================== 辅助函数 ====================

// 根据请求大小计算 size class 索引
export function getSizeClass(size) {
    for (let i = 0; i < NUM_SIZE_CLASSES; i++) {
        if (size <= SIZE_CLASSES[i]) {
            return i;
        }
    }
    return -1; // 大对象
}

export function alignUp(size) {
    return (size + ALIGNMENT - 1) & ~(ALIGNMENT - 1);
}

// 计算分配需要的总大小（包括头）
export function totalSize(requestedSize) {
    return alignUp(requestedSize + HEADER_SIZE);
}

// ==================== 统一 Allocator 生成器 ====================

export class AllocatorGenerator {
    constructor(vm, options = {}) {
        this.vm = vm;
        this.moduleRegistrySize = Math.max(1, options.moduleRegistrySize || 32);
        // wasm32 线性内存 4GB 封顶:28GB 预留不可行,堆/位图/标记栈按比例缩小。
        // native 路径取模块常量原值(发射字节逐位不变)。
        if (vm.platform === "wasi") {
            this.heapSize = 1024 * 1024 * 1024; // 1GB
            this.markStackSize = 64 * 1024 * 1024; // 64MB
        } else {
            this.heapSize = INITIAL_HEAP_SIZE;
            this.markStackSize = GC_MARK_STACK_SIZE;
        }
        this.bitmapSize = Math.floor(this.heapSize / 64);
    }

    // 获取平台相关的系统调用号
    getSyscallNum(name) {
        const platform = this.vm.platform;
        const arch = this.vm.arch;

        if (platform === "windows") {
            // Windows 使用 API 调用，不用系统调用号
            return -1;
        }

        if (platform === "wasi") {
            // wasi 号名空间 = linux-x64,宿主 shim 解释(mmap=arena bump)
            if (name === "mmap") return Syscall.LINUX_MMAP;
            if (name === "munmap") return Syscall.LINUX_MUNMAP;
            if (name === "exit") return Syscall.LINUX_EXIT;
            if (name === "write") return Syscall.LINUX_WRITE;
        }

        if (name === "mmap") {
            if (platform === "linux" && arch === "arm64") return Syscall.LINUX_MMAP_ARM64;
            if (platform === "linux") return Syscall.LINUX_MMAP;
            if (platform === "macos" && arch === "arm64") return Syscall.MACOS_MMAP_ARM64;
            if (platform === "macos") return Syscall.MACOS_MMAP_X64;
        }
        if (name === "munmap") {
            if (platform === "linux" && arch === "arm64") return Syscall.LINUX_MUNMAP_ARM64;
            if (platform === "linux") return Syscall.LINUX_MUNMAP;
            if (platform === "macos" && arch === "arm64") return Syscall.MACOS_MUNMAP_ARM64;
            if (platform === "macos") return Syscall.MACOS_MUNMAP_X64;
        }
        if (name === "exit") {
            if (platform === "linux" && arch === "arm64") return Syscall.LINUX_EXIT_ARM64;
            if (platform === "linux") return Syscall.LINUX_EXIT;
            if (platform === "macos" && arch === "arm64") return Syscall.MACOS_EXIT_ARM64;
            if (platform === "macos") return Syscall.MACOS_EXIT_X64;
        }
        if (name === "write") {
            if (platform === "linux" && arch === "arm64") return Syscall.LINUX_WRITE_ARM64;
            if (platform === "linux") return Syscall.LINUX_WRITE;
            if (platform === "macos" && arch === "arm64") return Syscall.MACOS_WRITE_ARM64;
            if (platform === "macos") return Syscall.MACOS_WRITE_X64;
        }
        throw new Error("Unknown syscall: " + name);
    }

    // mmap flags
    getMmapFlags() {
        const platform = this.vm.platform;
        // linux: MAP_PRIVATE(0x2) | MAP_ANON(0x20) | MAP_NORESERVE(0x4000)
        //   MAP_NORESERVE 使 28GB 初始堆只保留地址空间、不预占 swap/commit——
        //   严格 overcommit 的机器(如 GitHub runner)也能启动;页在写入时才提交,
        //   编译小程序只触碰少量页,不需要真的有 28GB 内存。
        // macOS: MAP_ANON(0x1000) | MAP_PRIVATE(0x2);匿名 mmap 本就惰性提交,无需 NORESERVE。
        return platform === "linux" ? 0x4022 : 0x1002;
    }

    // 生成堆初始化代码
    generateHeapInit() {
        const vm = this.vm;
        const platform = vm.platform;

        vm.label("_heap_init");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        if (platform === "windows") {
            // Windows: 使用 VirtualAlloc API
            // VirtualAlloc(lpAddress, dwSize, flAllocationType, flProtect)
            // lpAddress = NULL, dwSize = INITIAL_HEAP_SIZE
            // flAllocationType = MEM_COMMIT | MEM_RESERVE = 0x3000
            // flProtect = PAGE_READWRITE = 0x04
            vm.movImm(VReg.A0, 0); // lpAddress = NULL
            vm.movImm(VReg.A1, this.heapSize); // dwSize
            vm.movImm(VReg.A2, 0x3000); // MEM_COMMIT | MEM_RESERVE
            vm.movImm(VReg.A3, 0x04); // PAGE_READWRITE

            // 调用 VirtualAlloc (IAT slot 0)
            vm.callWindowsAPI(0);
        } else {
            // Unix: 使用 mmap 系统调用
            // mmap(addr=0, len=INITIAL_HEAP_SIZE, prot=RW, flags=ANON|PRIVATE, fd=-1, offset=0)
            vm.movImm(VReg.A0, 0); // addr = NULL
            vm.movImm(VReg.A1, this.heapSize); // len
            vm.movImm(VReg.A2, 3); // PROT_READ | PROT_WRITE
            vm.movImm(VReg.A3, this.getMmapFlags()); // flags
            vm.movImm64(VReg.A4, 0xffffffffffffffffn); // fd = -1（用正 BigInt 字面量表示全 1，
            // 避免 -1n：编译产物里一元负号作用于 BigInt 会得到 object 而非 bigint，
            // movImm64 走错分支 → mmap fd 错 → 自举产物 _heap_init 失败）
            vm.movImm(VReg.A5, 0); // offset = 0

            vm.syscall(this.getSyscallNum("mmap"));
        }

        // 保存 heap base
        vm.mov(VReg.S0, VReg.RET);

        // 检查是否成功 (返回 NULL/0 或 -1 表示失败)
        vm.movImm64(VReg.V1, 0xffffffffffffffffn); // -1 全 1（同上，避免 -1n 在自举里坏）
        vm.cmp(VReg.S0, VReg.V1);
        vm.jeq("_heap_init_fail");
        vm.cmpImm(VReg.S0, 65536); // 至少 64KB 以上
        vm.jlt("_heap_init_fail");

        // 初始化元数据
        vm.lea(VReg.V1, "_heap_meta");

        // heap_base
        vm.store(VReg.V1, META_HEAP_BASE, VReg.S0);

        // heap_size
        vm.movImm(VReg.V2, this.heapSize);
        vm.store(VReg.V1, META_HEAP_SIZE, VReg.V2);

        // heap_used = 0 (bump allocator 从 heap_base 开始)
        vm.movImm(VReg.V2, 0);
        vm.store(VReg.V1, META_HEAP_USED, VReg.V2);

        // gc_running = 0
        vm.store(VReg.V1, META_GC_RUNNING, VReg.V2);

        // 初始化所有 free_lists[0..17] = NULL
        vm.movImm(VReg.V2, 0);
        for (let i = 0; i < NUM_SIZE_CLASSES; i++) {
            vm.store(VReg.V1, META_FREE_LISTS + i * 8, VReg.V2);
        }

        // large_free = NULL
        vm.store(VReg.V1, META_LARGE_FREE, VReg.V2);

        // gc_count = 0
        vm.store(VReg.V1, META_GC_COUNT, VReg.V2);

        // alloc_count = 0
        vm.store(VReg.V1, META_ALLOC_COUNT, VReg.V2);

        // ==================== GC 状态初始化 ====================
        // 为标记栈（gray 队列）单独 mmap 一段区域（1GB 保留、惰性提交）。
        // 独立于堆，避免标记阶段污染堆/free-list；深度只提交实际用到的页。
        if (platform === "windows") {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.markStackSize));
            vm.movImm(VReg.A2, 0x3000);
            vm.movImm(VReg.A3, 0x04);
            vm.callWindowsAPI(0);
        } else {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.markStackSize));
            vm.movImm(VReg.A2, 3);
            vm.movImm(VReg.A3, this.getMmapFlags());
            vm.movImm64(VReg.A4, 0xffffffffffffffffn);
            vm.movImm(VReg.A5, 0);
            vm.syscall(this.getSyscallNum("mmap"));
        }
        // 校验失败（-1 / 0）
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm64(VReg.V1, 0xffffffffffffffffn);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_heap_init_fail");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_heap_init_fail");

        vm.lea(VReg.V1, "_gc_mstack_base");
        vm.store(VReg.V1, 0, VReg.S1);
        vm.lea(VReg.V1, "_gc_mstack_cap");
        vm.movImm64(VReg.V2, BigInt(Math.floor(this.markStackSize / 8)));
        vm.store(VReg.V1, 0, VReg.V2);
        // top / overflow / alloc_since / live = 0
        vm.movImm(VReg.V2, 0);
        vm.lea(VReg.V1, "_gc_mstack_top");
        vm.store(VReg.V1, 0, VReg.V2);
        vm.lea(VReg.V1, "_gc_overflow");
        vm.store(VReg.V1, 0, VReg.V2);
        vm.lea(VReg.V1, "_gc_alloc_since");
        vm.store(VReg.V1, 0, VReg.V2);
        vm.lea(VReg.V1, "_gc_live_bytes");
        vm.store(VReg.V1, 0, VReg.V2);

        // ==================== 分代 GC 基建(#11 阶段b) ====================
        // 一段 192MB 惰性提交区:前 64MB = box 登记表(所有装箱变量的块指针,
        // minor GC 全量当根扫 box[0],以免遗漏「老 box 写入 young 值」的边——
        // 编译器内联发射 box 写,无法可靠加写屏障,登记表是结构性替代);
        // 后 128MB = 记忆集(老容器块指针,运行时写点屏障记录)。
        if (platform === "windows") {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(192 * 1024 * 1024));
            vm.movImm(VReg.A2, 0x3000);
            vm.movImm(VReg.A3, 0x04);
            vm.callWindowsAPI(0);
        } else {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(192 * 1024 * 1024));
            vm.movImm(VReg.A2, 3);
            vm.movImm(VReg.A3, this.getMmapFlags());
            vm.movImm64(VReg.A4, 0xffffffffffffffffn);
            vm.movImm(VReg.A5, 0);
            vm.syscall(this.getSyscallNum("mmap"));
        }
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm64(VReg.V1, 0xffffffffffffffffn);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_heap_init_fail");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_heap_init_fail");
        vm.lea(VReg.V1, "_box_reg_base");
        vm.store(VReg.V1, 0, VReg.S1);
        vm.movImm64(VReg.V2, BigInt(64 * 1024 * 1024));
        vm.add(VReg.S1, VReg.S1, VReg.V2);
        vm.lea(VReg.V1, "_rs_base");
        vm.store(VReg.V1, 0, VReg.S1);
        vm.movImm(VReg.V2, 0);
        vm.lea(VReg.V1, "_box_reg_top");
        vm.store(VReg.V1, 0, VReg.V2);
        vm.lea(VReg.V1, "_rs_top");
        vm.store(VReg.V1, 0, VReg.V2);
        vm.lea(VReg.V1, "_rs_overflow");
        vm.store(VReg.V1, 0, VReg.V2);
        // young 起点 = heap_base(此处 _heap_ptr 数据槽尚未赋值,读 META_HEAP_BASE——
        // init 时二者等价;曾误读 _heap_ptr 得 0 → 首次 minor sweep 从 NULL 扫崩)
        vm.lea(VReg.V1, "_heap_meta");
        vm.load(VReg.V2, VReg.V1, META_HEAP_BASE);
        vm.lea(VReg.V1, "_gc_last_ptr");
        vm.store(VReg.V1, 0, VReg.V2);

        // RS 去重位图(与标记位图同尺寸,惰性)。分代 GC 已是缺省 → 屏障恒开、恒 mmap。
        {
            if (platform === "windows") {
                vm.movImm(VReg.A0, 0);
                vm.movImm64(VReg.A1, BigInt(this.bitmapSize));
                vm.movImm(VReg.A2, 0x3000);
                vm.movImm(VReg.A3, 0x04);
                vm.callWindowsAPI(0);
            } else {
                vm.movImm(VReg.A0, 0);
                vm.movImm64(VReg.A1, BigInt(this.bitmapSize));
                vm.movImm(VReg.A2, 3);
                vm.movImm(VReg.A3, this.getMmapFlags());
                vm.movImm64(VReg.A4, 0xffffffffffffffffn);
                vm.movImm(VReg.A5, 0);
                vm.syscall(this.getSyscallNum("mmap"));
            }
            vm.mov(VReg.S1, VReg.RET);
            vm.movImm64(VReg.V1, 0xffffffffffffffffn);
            vm.cmp(VReg.S1, VReg.V1);
            vm.jeq("_heap_init_fail");
            vm.cmpImm(VReg.S1, 0);
            vm.jeq("_heap_init_fail");
            vm.lea(VReg.V1, "_rs_dedup_base");
            vm.store(VReg.V1, 0, VReg.S1);
        }

        // [GC_SHADOW] 影子快照区:与标记位图同尺寸(惰性提交,零实占)。
        // 曾设 16MB(覆盖 young ≤1GB),1GB 阈值自编译触发时 young≈1.07GB →
        // 快照段 16.8MB 越界写 → 一致 SIGSEGV(比较前崩,MISS=0 无产物)。
        if (process.env.GC_SHADOW) {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.bitmapSize));
            vm.movImm(VReg.A2, 3);
            vm.movImm(VReg.A3, this.getMmapFlags());
            vm.movImm64(VReg.A4, 0xffffffffffffffffn);
            vm.movImm(VReg.A5, 0);
            vm.syscall(this.getSyscallNum("mmap"));
            vm.mov(VReg.S1, VReg.RET);
            vm.movImm64(VReg.V1, 0xffffffffffffffffn);
            vm.cmp(VReg.S1, VReg.V1);
            vm.jeq("_heap_init_fail");
            vm.cmpImm(VReg.S1, 0);
            vm.jeq("_heap_init_fail");
            vm.lea(VReg.V1, "_shadow_base");
            vm.store(VReg.V1, 0, VReg.S1);
        }

        // trigger 缺省 = 256MB nursery(分代 GC 缺省开;实验甜点:耗时 ~+5% 换 RSS −30%)。
        // [GC_THRESHOLD] env 可调;[GC_DISABLE] 不触发;[GC_FULLONLY] 旧行为
        // (full-only + GC_MIN_THRESHOLD 4GB,即 v1.1.x 的产品缺省)。
        vm.lea(VReg.V1, "_gc_trigger");
        {
            const thr = process.env.GC_DISABLE ? 0x800000000
                : (process.env.GC_THRESHOLD ? parseInt(process.env.GC_THRESHOLD, 10)
                    : (process.env.GC_FULLONLY ? GC_MIN_THRESHOLD : 268435456));
            vm.movImm64(VReg.V2, BigInt(thr));
        }
        vm.store(VReg.V1, 0, VReg.V2);
        // GOGC 式 full 步调初值:首个 full 在累计分配 512MB 时(其后 = live×2)
        {
            vm.lea(VReg.V1, "_gc_full_trigger");
            vm.movImm64(VReg.V2, BigInt(512 * 1024 * 1024));
            vm.store(VReg.V1, 0, VReg.V2);
        }

        // 为标记位图 mmap 一段区域（每 64 字节堆 → 1 字节，惰性提交）
        if (platform === "windows") {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.bitmapSize));
            vm.movImm(VReg.A2, 0x3000);
            vm.movImm(VReg.A3, 0x04);
            vm.callWindowsAPI(0);
        } else {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.bitmapSize));
            vm.movImm(VReg.A2, 3);
            vm.movImm(VReg.A3, this.getMmapFlags());
            vm.movImm64(VReg.A4, 0xffffffffffffffffn);
            vm.movImm(VReg.A5, 0);
            vm.syscall(this.getSyscallNum("mmap"));
        }
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm64(VReg.V1, 0xffffffffffffffffn);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_heap_init_fail");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_heap_init_fail");
        vm.lea(VReg.V1, "_gc_bitmap_base");
        vm.store(VReg.V1, 0, VReg.S1);

        // 块起始位图(与标记位图同尺寸,惰性提交):_alloc 出口登记每个块起始 bit。
        // mark 用它把「内部指针」解析回真容器块起始 —— 修复 2026-07-10 定位的
        // 布局运气毁堆:栈上仅存内部指针(如属性/内容游标)时,mark_one 盲目
        // ptr-16 标错位,真容器被 sweep 回收 → GC 后随机毁堆(环境体积敏感)。
        if (platform === "windows") {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.bitmapSize));
            vm.movImm(VReg.A2, 0x3000);
            vm.movImm(VReg.A3, 0x04);
            vm.callWindowsAPI(0);
        } else {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.bitmapSize));
            vm.movImm(VReg.A2, 3);
            vm.movImm(VReg.A3, this.getMmapFlags());
            vm.movImm64(VReg.A4, 0xffffffffffffffffn);
            vm.movImm(VReg.A5, 0);
            vm.syscall(this.getSyscallNum("mmap"));
        }
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm64(VReg.V1, 0xffffffffffffffffn);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_heap_init_fail");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_heap_init_fail");
        vm.lea(VReg.V1, "_gc_startmap_base");
        vm.store(VReg.V1, 0, VReg.S1);

        // span 页映射(1B/64KB 页,惰性提交):mark 对 span 页内指针 O(1) 解析块起始
        if (platform === "windows") {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.heapSize / SPAN_SIZE));
            vm.movImm(VReg.A2, 0x3000);
            vm.movImm(VReg.A3, 0x04);
            vm.callWindowsAPI(0);
        } else {
            vm.movImm(VReg.A0, 0);
            vm.movImm64(VReg.A1, BigInt(this.heapSize / SPAN_SIZE));
            vm.movImm(VReg.A2, 3);
            vm.movImm(VReg.A3, this.getMmapFlags());
            vm.movImm64(VReg.A4, 0xffffffffffffffffn);
            vm.movImm(VReg.A5, 0);
            vm.syscall(this.getSyscallNum("mmap"));
        }
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm64(VReg.V1, 0xffffffffffffffffn);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_heap_init_fail");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_heap_init_fail");
        vm.lea(VReg.V1, "_gc_pagemap_base");
        vm.store(VReg.V1, 0, VReg.S1);

        // 初始化 bump pointer (_heap_ptr = heap_base)
        vm.lea(VReg.V1, "_heap_ptr");
        vm.store(VReg.V1, 0, VReg.S0);

        // 保存 heap base（兼容旧代码）
        vm.lea(VReg.V1, "_heap_base");
        vm.store(VReg.V1, 0, VReg.S0);

        vm.epilogue([VReg.S0, VReg.S1], 0);

        // 失败处理
        vm.label("_heap_init_fail");
        const initFailMsg = "FATAL: Memory allocation failed during heap initialization\n";
        vm.lea(VReg.A1, this.vm.asm.addString(initFailMsg));
        vm.movImm(VReg.A2, initFailMsg.length);
        vm.movImm(VReg.A0, 1);
        if (this.vm.platform === "wasi") {
            vm.syscall(1);
            vm.movImm(VReg.A0, 1);
            vm.syscall(60);
        } else if (this.vm.arch === "arm64") {
            vm.syscall(this.vm.platform === "linux" ? 64 : 4);
            vm.movImm(VReg.A0, 1);
            vm.syscall(this.vm.platform === "linux" ? 93 : 1);
        } else {
            vm.syscall(this.vm.platform === "linux" ? 1 : 0x2000004);
            vm.movImm(VReg.A0, 1);
            vm.syscall(this.vm.platform === "linux" ? 60 : 0x2000001);
        }
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // ==================== Go 风格三级分配器 ====================
    //
    // _alloc(size) 分配流程:
    // 1. size <= 512: 查找对应 size class 的 free list
    //    - 有空闲块: O(1) 从链表头取出
    //    - 无空闲块: 从 bump allocator 分配新块
    // 2. size > 512: 大对象
    //    - 先检查 large_free 链表（best-fit）
    //    - 否则从 bump allocator 分配

    // 生成内存分配代码
    generateAlloc() {
        const vm = this.vm;
        // [M4] per-P mcache 无锁分配路径仅在 linux-arm64 发射(真原子/spinlock 在此)。
        // 其余平台(macos-arm64 自举门、x64、wasm)完全不发射下列 GOMAXPROCS 分支 →
        // 单 M 产物中 `_alloc` 逐字节不变(x64/wasm 段 TLS 多 M 属后续,§3.2)。
        const isParallel = vm.platform === "linux" && vm.arch === "arm64";

        // _alloc: 分配内存
        // A0 = 请求大小（不包括头）
        // 返回: RET = 分配的内存地址（用户数据区），0 表示失败
        vm.label("_alloc");
        // [ALLOC_DBG] 入口捕获调用者返回地址（LR），prologue 之前——prologue 会把 LR 存栈覆盖用途。
        if (process.env.ALLOC_DBG) {
            vm.mov(VReg.V0, VReg.LR);
            vm.lea(VReg.V1, "_alloc_dbg_lr");
            vm.store(VReg.V1, 0, VReg.V0);
            vm.mov(VReg.V0, VReg.FP);
            vm.lea(VReg.V1, "_alloc_dbg_fp");
            vm.store(VReg.V1, 0, VReg.V0);
        }
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        // 对齐请求大小到 8 字节
        vm.addImm(VReg.V0, VReg.A0, 7);
        vm.movImm(VReg.V1, -8);
        vm.and(VReg.S0, VReg.V0, VReg.V1); // S0 = 对齐后的用户大小

        // [ALLOC_DBG] 抓垃圾 size：正常自举无单次 >1GB 分配。命中即打印 size+LR 后 abort。
        if (process.env.ALLOC_DBG) {
            vm.movImm64(VReg.V1, 0x40000000n); // 1GB
            vm.cmp(VReg.S0, VReg.V1);
            vm.jle("_alloc_dbg_ok");
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_alloc_dbg_report");
            vm.label("_alloc_dbg_ok");
        }

        // ==================== GC 触发检查 ====================
        // [M5] GOMAXPROCS>1:`_alloc` **不内联触发 GC**。多 M 下 GC 必须 STW(停其它 M 后单
        // 协调者扫根/回收),否则协调者扫描/sweep 时另一 M 仍在改堆 → 损坏。多 M 的 GC 改由
        // STW 协调者显式驱动(`_stw_begin`+`_gc_collect`+`_stw_end`,见 parallel_sched.js
        // `_par_gc_smoke` / 未来调度环圈首的压力触发)。此分支仅 linux-arm64 发射,GOMAXPROCS=1
        // (含 macos 自举门)逐字节不变。
        if (isParallel) {
            vm.lea(VReg.V1, "_gomaxprocs");
            vm.load(VReg.V1, VReg.V1, 0);
            vm.cmpImm(VReg.V1, 1);
            vm.jgt("_alloc_after_gc");
        }
        // 基于「距上次 GC 分配量」触发（不是 heap_used——sweep 后复用不推进 heap_used）。
        // alloc_since += 本次块大小(近似 size+HEADER)；超过 trigger 且未在 GC 中 → _gc_collect。
        vm.lea(VReg.V2, "_heap_meta");
        vm.load(VReg.V1, VReg.V2, META_GC_RUNNING);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_alloc_after_gc"); // 正在 GC（不应发生，防重入）
        vm.lea(VReg.V2, "_gc_alloc_since");
        vm.load(VReg.V1, VReg.V2, 0);
        vm.addImm(VReg.V3, VReg.S0, HEADER_SIZE);
        vm.add(VReg.V1, VReg.V1, VReg.V3);
        vm.store(VReg.V2, 0, VReg.V1);
        vm.lea(VReg.V2, "_gc_trigger");
        vm.load(VReg.V3, VReg.V2, 0);
        vm.cmp(VReg.V1, VReg.V3);
        vm.jle("_alloc_after_gc");
        // [批次D] 协程栈上不触发 GC:栈根扫描只覆盖 [SP,_stack_base)(主栈区间),
        // 在协程堆栈上执行时 SP 落在堆内,该区间会横跨堆与主栈之间的未映射地址 → 崩,
        // 且真正的根在协程栈里也扫不到。推迟到回主协程后的下一次分配再收
        // (alloc_since 已累计不清零,不丢触发;协程栈块经 保守扫描链
        // genobj/promise→coro→栈块 整块标记,挂起协程的活值不漏根)。
        // V2/V3 此处已死(736 行重载);x64 上 V2/V3=A2/A4 在 695 行起本就被覆盖,无新增破坏。
        vm.lea(VReg.V2, "_scheduler_current");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.lea(VReg.V3, "_scheduler_main");
        vm.load(VReg.V3, VReg.V3, 0);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jne("_alloc_after_gc");
        // ---- 寄存器根：GC 前把仍持 mutator 活值的调用者保存寄存器存进 _gc_regsave ----
        // 此刻 A0-A5、V4-V7 未被 _alloc 前段(仅用 V0-V3/S0)碰过，仍是调用者传入/持有的值；
        // 其中可能有跨 _alloc 调用只在寄存器里的活堆指针。存进被扫描的数据段缓冲 → 被当根标记，
        // 且 GC 后原样恢复 → 保持 _alloc「不破坏这些寄存器」的隐式契约(无 GC 时也不碰它们)。
        // 用 V0 当基址暂存器：V0 的 mutator 值已被前段(line ~486)覆盖，无需保留。
        vm.lea(VReg.V0, "_gc_regsave");
        vm.store(VReg.V0, 0, VReg.A0);
        vm.store(VReg.V0, 8, VReg.A1);
        vm.store(VReg.V0, 16, VReg.A2);
        vm.store(VReg.V0, 24, VReg.A3);
        vm.store(VReg.V0, 32, VReg.A4);
        vm.store(VReg.V0, 40, VReg.A5);
        vm.store(VReg.V0, 48, VReg.V4);
        vm.store(VReg.V0, 56, VReg.V5);
        vm.store(VReg.V0, 64, VReg.V6);
        vm.store(VReg.V0, 72, VReg.V7);

        // 分代调度(缺省):minor + GOGC 周期 full;rs/box 溢出退化 full。
        // [GC_FULLONLY] 保留旧 full-only 行为;[GC_SHADOW] 诊断模式。
        if (process.env.GC_SHADOW) {
            vm.call("_gc_collect_shadow");
            // 影子模式:mark 两遍+对照,回收按 full,不走下方分支
        } else if (!process.env.GC_FULLONLY) {
            // GOGC 式 full 步调:since_full += 本轮触发额(V1 仍 = alloc_since+size);
            // since_full ≥ full_trigger(= 上次 full 后 live×2)或 rs 溢出 → full,否则 minor。
            // sticky minor 不回收 old 垃圾,无周期 full 则 old 死块永生 —— 此步调即 Go 的
            // 「堆增长一倍再收全堆」。
            vm.lea(VReg.V0, "_gc_since_full");
            vm.load(VReg.V3, VReg.V0, 0);
            vm.add(VReg.V3, VReg.V3, VReg.V1);
            vm.store(VReg.V0, 0, VReg.V3);
            vm.lea(VReg.V0, "_gc_full_trigger");
            vm.load(VReg.V6, VReg.V0, 0);
            vm.cmp(VReg.V3, VReg.V6);
            vm.jge("_alloc_gc_full");
            vm.lea(VReg.V0, "_rs_overflow");
            vm.load(VReg.V1, VReg.V0, 0);
            vm.cmpImm(VReg.V1, 0);
            vm.jne("_alloc_gc_full");
            vm.call("_gc_collect_minor");
            vm.jmp("_alloc_gc_done");
            vm.label("_alloc_gc_full");
            vm.call("_gc_collect"); // full 尾部会清 rs_overflow/rs_top、重设步调
            vm.label("_alloc_gc_done");
        } else {
            vm.call("_gc_collect"); // S0（对齐大小）为 callee-saved，_gc_collect 会保存/恢复
        }

        // GC 后恢复(GC 不移动对象，指针仍有效；恢复到入口值 → 与无 GC 路径寄存器状态一致)
        vm.lea(VReg.V0, "_gc_regsave");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.load(VReg.A1, VReg.V0, 8);
        vm.load(VReg.A2, VReg.V0, 16);
        vm.load(VReg.A3, VReg.V0, 24);
        vm.load(VReg.A4, VReg.V0, 32);
        vm.load(VReg.A5, VReg.V0, 40);
        vm.load(VReg.V4, VReg.V0, 48);
        vm.load(VReg.V5, VReg.V0, 56);
        vm.load(VReg.V6, VReg.V0, 64);
        vm.load(VReg.V7, VReg.V0, 72);
        vm.label("_alloc_after_gc");

        // 判断是小对象还是大对象
        vm.movImm(VReg.V1, MAX_SMALL_SIZE);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jgt("_alloc_large");

        // ========== 小对象分配 ==========
        // 计算 size class 索引
        // 传入对齐后的用户大小
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_get_size_class");
        vm.mov(VReg.S1, VReg.RET); // S1 = size class index

        // 检查 free list
        vm.lea(VReg.V2, "_heap_meta");
        vm.shl(VReg.V3, VReg.S1, 3); // index * 8
        vm.addImm(VReg.V3, VReg.V3, META_FREE_LISTS);
        vm.add(VReg.V3, VReg.V2, VReg.V3); // V3 = &free_lists[class]
        vm.load(VReg.V4, VReg.V3, 0); // V4 = free_lists[class]

        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_alloc_small_bump"); // 空闲链表为空，走 bump

        // 从 free list 取出第一个块
        // V4 指向块头（header），需要读取 next 指针
        vm.load(VReg.V5, VReg.V4, HDR_NEXT); // V5 = next
        vm.store(VReg.V3, 0, VReg.V5); // free_lists[class] = next

        // 重写对象头为本次请求的 size/class：复用块沿用旧 size 会让 GC 保守扫描
        // 按旧（可能更小）size 遍历用户区 → 漏掉新对象在更高偏移写入的指针 → 误回收活对象。
        // 同一 free-list 内 class 相同，物理块大小不变，故 sweep 复算 footprint 仍一致。
        vm.shl(VReg.V5, VReg.S0, SIZE_SHIFT); // user_size << 16
        vm.shl(VReg.V6, VReg.S1, CLASS_SHIFT); // class << 6
        vm.or(VReg.V5, VReg.V5, VReg.V6);
        vm.store(VReg.V4, HDR_FLAGS_SIZE, VReg.V5);

        // 清除 next 指针（标记为已分配）
        vm.movImm(VReg.V5, 0);
        vm.store(VReg.V4, HDR_NEXT, VReg.V5);

        // 更新 alloc_count
        vm.lea(VReg.V2, "_heap_meta");
        vm.load(VReg.V5, VReg.V2, META_ALLOC_COUNT);
        vm.addImm(VReg.V5, VReg.V5, 1);
        vm.store(VReg.V2, META_ALLOC_COUNT, VReg.V5);

        // 清零复用块的用户区 [user, user+S0)：复用块保留上次生命周期的陈旧内容，
        // 其中的陈旧堆指针会被 GC 保守扫描误当活引用（过度保留、内存不降），
        // 且运行时多处假定新分配内存为零。逐 8 字节清零（S0 恒 8 对齐）。
        vm.addImm(VReg.V5, VReg.V4, HEADER_SIZE); // cur
        vm.add(VReg.V6, VReg.V5, VReg.S0); // end
        vm.movImm(VReg.V7, 0);
        vm.label("_alloc_small_zloop");
        vm.cmp(VReg.V5, VReg.V6);
        vm.jge("_alloc_small_zdone");
        vm.store(VReg.V5, 0, VReg.V7);
        vm.addImm(VReg.V5, VReg.V5, 8);
        vm.jmp("_alloc_small_zloop");
        vm.label("_alloc_small_zdone");

        // 返回用户数据区地址（跳过头）
        vm.addImm(VReg.RET, VReg.V4, HEADER_SIZE);
        vm.jmp("_alloc_setstart"); // 统一尾部:登记块起始 bit 后返回

        // ========== 小对象 Bump 分配(span 页模型,#20 S1)==========
        // 每 class 独占 64KB 对齐 span,块 stride=classSize+16 格网排布 →
        // mark 对 span 页内任意指针 O(1) 解析。gap/span 尾余写 class=63 哨兵块
        // (footprint=size+16),保持 sweep 线性头行走同步。
        vm.label("_alloc_small_bump");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_get_class_size");
        vm.mov(VReg.S2, VReg.RET); // S2 = class size (用户区大小)
        vm.addImm(VReg.S3, VReg.S2, HEADER_SIZE); // S3 = stride

        // [M4] GOMAXPROCS>1:小对象 bump 走当前 M 的 P 的 per-P mcache(无锁快路)。
        // GOMAXPROCS=1(默认/自举门)fall-through 至下方全局 `_span_cur` 路径,逐字节不变。
        if (isParallel) {
            vm.lea(VReg.V0, "_gomaxprocs");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, 1);
            vm.jgt("_alloc_small_mm");
        }

        // ---- span carve 快路 ----
        vm.lea(VReg.V1, "_span_cur");
        vm.shl(VReg.V2, VReg.S1, 3);
        vm.add(VReg.V1, VReg.V1, VReg.V2); // &span_cur[class]
        vm.load(VReg.V4, VReg.V1, 0); // cur
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_alloc_span_new");
        vm.lea(VReg.V3, "_span_end");
        vm.add(VReg.V3, VReg.V3, VReg.V2);
        vm.load(VReg.V5, VReg.V3, 0); // end
        vm.add(VReg.V6, VReg.V4, VReg.S3); // cur+stride
        vm.cmp(VReg.V6, VReg.V5);
        vm.jgt("_alloc_span_new"); // span 耗尽
        vm.store(VReg.V1, 0, VReg.V6); // cur += stride

        // ---- 哨兵 + 块头初始化(V4=块头,V6=下一游标)----
        vm.label("_alloc_span_hdr");
        // 尾哨兵:page_end=(V4&~0xFFFF)+64KB;V6<page_end 时 [V6]=(page_end-V6-16)<<16|63<<6
        vm.movImm64(VReg.V7, 0xffffffffffff0000n);
        vm.and(VReg.V7, VReg.V4, VReg.V7);
        vm.movImm64(VReg.V0, BigInt(SPAN_SIZE));
        vm.add(VReg.V7, VReg.V7, VReg.V0); // page_end
        vm.cmp(VReg.V6, VReg.V7);
        vm.jge("_alloc_span_nosent");
        vm.sub(VReg.V0, VReg.V7, VReg.V6);
        vm.subImm(VReg.V0, VReg.V0, HEADER_SIZE);
        vm.shlImm(VReg.V0, VReg.V0, SIZE_SHIFT);
        vm.movImm(VReg.V5, SPAN_SENTINEL_CLASS << CLASS_SHIFT);
        vm.or(VReg.V0, VReg.V0, VReg.V5);
        vm.store(VReg.V6, 0, VReg.V0); // 哨兵 flags
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V6, HDR_NEXT, VReg.V0); // 哨兵 next=0
        vm.label("_alloc_span_nosent");

        vm.label("_alloc_blk_init");
        // 初始化对象头: flags_and_size = size << 16 | class << 6
        vm.shl(VReg.V5, VReg.S0, SIZE_SHIFT);
        vm.shl(VReg.V6, VReg.S1, CLASS_SHIFT);
        vm.or(VReg.V5, VReg.V5, VReg.V6);
        vm.store(VReg.V4, HDR_FLAGS_SIZE, VReg.V5);
        vm.movImm(VReg.V5, 0);
        vm.store(VReg.V4, HDR_NEXT, VReg.V5);
        vm.lea(VReg.V2, "_heap_meta");
        vm.load(VReg.V5, VReg.V2, META_ALLOC_COUNT);
        vm.addImm(VReg.V5, VReg.V5, 1);
        vm.store(VReg.V2, META_ALLOC_COUNT, VReg.V5);
        vm.addImm(VReg.RET, VReg.V4, HEADER_SIZE);
        vm.jmp("_alloc_setstart"); // 统一尾部:登记块起始 bit 后返回

        // ---- 新 span:全局 bump 取 64KB 对齐段 ----
        vm.label("_alloc_span_new");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V4, VReg.V1, 0); // 预期段起点
        vm.movImm64(VReg.V0, BigInt(SPAN_SIZE - 1));
        vm.add(VReg.V5, VReg.V4, VReg.V0);
        vm.movImm64(VReg.V0, 0xffffffffffff0000n);
        vm.and(VReg.V5, VReg.V5, VReg.V0); // aligned
        vm.sub(VReg.V6, VReg.V5, VReg.V4); // gap(8 的倍数)
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_alloc_span_gapok");
        vm.cmpImm(VReg.V6, HEADER_SIZE);
        vm.jge("_alloc_span_gapok");
        // gap==8:容不下哨兵头 → 再挪一页
        vm.movImm64(VReg.V0, BigInt(SPAN_SIZE));
        vm.add(VReg.V5, VReg.V5, VReg.V0);
        vm.add(VReg.V6, VReg.V6, VReg.V0);
        vm.label("_alloc_span_gapok");
        vm.movImm64(VReg.V0, BigInt(SPAN_SIZE));
        vm.add(VReg.A0, VReg.V6, VReg.V0); // req = gap + 64KB
        // V 寄存器跨 call 不保活(曾直接沿用 → _bump_alloc 毁 V4/V5/V6 → 必走重定位
        // 兜底 → 垃圾尺寸哨兵 + 每次分配吃 64KB → 28GB 耗尽触发 grow 重定位毁
        // heap_meta)。压栈保活,gap 由 V5-V4 重导出。
        vm.push(VReg.V4); // 预期段起点
        vm.push(VReg.V5); // aligned
        vm.call("_bump_alloc");
        vm.pop(VReg.V5);
        vm.pop(VReg.V4);
        vm.sub(VReg.V6, VReg.V5, VReg.V4); // gap
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_alloc_fail");
        // grow 重定位防御:段起点 != 预期(28GB 初始堆下不发生)→ 整段写哨兵后走 legacy 单块
        vm.cmp(VReg.RET, VReg.V4);
        vm.jne("_alloc_small_relocated");
        // gap 哨兵(在旧 heap_ptr 处,覆盖 [V4, V5))
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_alloc_span_nogap");
        vm.subImm(VReg.V0, VReg.V6, HEADER_SIZE);
        vm.shlImm(VReg.V0, VReg.V0, SIZE_SHIFT);
        vm.movImm(VReg.V3, SPAN_SENTINEL_CLASS << CLASS_SHIFT);
        vm.or(VReg.V0, VReg.V0, VReg.V3);
        vm.store(VReg.V4, 0, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V4, HDR_NEXT, VReg.V0);
        vm.label("_alloc_span_nogap");
        // pagemap[(V5-heap_base)>>16] = class+1
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V0, VReg.V0, META_HEAP_BASE);
        vm.sub(VReg.V3, VReg.V5, VReg.V0);
        vm.shrImm(VReg.V3, VReg.V3, SPAN_SHIFT);
        vm.lea(VReg.V0, "_gc_pagemap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.add(VReg.V0, VReg.V0, VReg.V3);
        vm.addImm(VReg.V3, VReg.S1, 1);
        vm.storeByte(VReg.V0, 0, VReg.V3);
        // span_end[class] = V5 + usable[class];span_cur[class] = V5 + stride;首块 = V5
        vm.shl(VReg.V3, VReg.S1, 3);
        vm.lea(VReg.V0, "_gc_spanusable");
        vm.add(VReg.V0, VReg.V0, VReg.V3);
        vm.load(VReg.V0, VReg.V0, 0);
        // dest==a 形式!x64 后端对 add(dest,a,b) 的 dest==b 路径用 R10(=V5)当草稿,
        // 会踩掉 V5(span 基址)——arm64 三操作数无此问题,曾致 x64-only 毁堆。
        vm.add(VReg.V0, VReg.V0, VReg.V5);
        vm.lea(VReg.V1, "_span_end");
        vm.add(VReg.V1, VReg.V1, VReg.V3);
        vm.store(VReg.V1, 0, VReg.V0);
        vm.mov(VReg.V4, VReg.V5); // V4 = 首块
        vm.add(VReg.V6, VReg.V5, VReg.S3); // V6 = 新 cur
        vm.lea(VReg.V1, "_span_cur");
        vm.add(VReg.V1, VReg.V1, VReg.V3);
        vm.store(VReg.V1, 0, VReg.V6);
        vm.jmp("_alloc_span_hdr");

        // ---- grow 重定位兜底:段整体写哨兵,退回单块 bump(极罕见)----
        vm.label("_alloc_small_relocated");
        vm.movImm64(VReg.V2, BigInt(SPAN_SIZE));
        vm.add(VReg.V2, VReg.V2, VReg.V6); // req
        vm.subImm(VReg.V2, VReg.V2, HEADER_SIZE);
        vm.shlImm(VReg.V2, VReg.V2, SIZE_SHIFT);
        vm.movImm(VReg.V3, SPAN_SENTINEL_CLASS << CLASS_SHIFT);
        vm.or(VReg.V2, VReg.V2, VReg.V3);
        vm.store(VReg.RET, 0, VReg.V2);
        vm.movImm(VReg.V2, 0);
        vm.store(VReg.RET, HDR_NEXT, VReg.V2);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_bump_alloc");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_alloc_fail");
        vm.mov(VReg.V4, VReg.RET);
        vm.jmp("_alloc_blk_init"); // 单块不写尾哨兵(不在 span 页)

        // [M4] ========== 小对象 per-P mcache 无锁 bump(GOMAXPROCS>1,linux-arm64)==========
        // 当前 M 的 P(经 _m_current_p 重定向 x28+MCTX_P)持有每 class 的 (cur,end) span 游标。
        // 快路:P.mc_cur[class] 内 bump,零锁(P 线程本地)。耗尽/空 → _mcache_refill(锁保护)。
        // 复用共享尾 `_alloc_span_hdr`(V4=块头,V6=下一游标)→ 尾哨兵 + 块头 + startmap。
        if (isParallel) {
            vm.label("_alloc_small_mm");
            vm.lea(VReg.V0, "_m_current_p");
            vm.load(VReg.V0, VReg.V0, 0);          // V0 = P
            vm.shl(VReg.V1, VReg.S1, 3);           // V1 = class*8
            vm.add(VReg.V2, VReg.V0, VReg.V1);     // V2 = P + class*8
            vm.load(VReg.V4, VReg.V2, P_MC_CUR);   // V4 = mc_cur[class]
            vm.cmpImm(VReg.V4, 0);
            vm.jeq("_alloc_mc_refill");
            vm.load(VReg.V5, VReg.V2, P_MC_END);   // V5 = mc_end[class]
            vm.add(VReg.V6, VReg.V4, VReg.S3);     // next = cur + stride
            vm.cmp(VReg.V6, VReg.V5);
            vm.jgt("_alloc_mc_refill");            // span 耗尽 → refill
            vm.store(VReg.V2, P_MC_CUR, VReg.V6);  // mc_cur[class] = next
            vm.jmp("_alloc_span_hdr");             // V4=块,V6=next → 共享尾
            vm.label("_alloc_mc_refill");
            vm.mov(VReg.A0, VReg.S1);              // class
            vm.mov(VReg.A1, VReg.S3);              // stride
            vm.call("_mcache_refill");             // RET=span 首块;已设 P.mc_cur/mc_end
            vm.mov(VReg.V4, VReg.RET);
            vm.add(VReg.V6, VReg.V4, VReg.S3);     // 下一游标 = 首块 + stride
            vm.jmp("_alloc_span_hdr");
        }

        // ========== 大对象分配 ==========
        vm.label("_alloc_large");
        // 先在 large_free 链表里首次匹配（块的可用用户区 >= 请求）。
        // 复用时不改对象头（size 保持原块大小）——这样 sweep 复算 footprint 仍精确，
        // GC 保守扫描按更大的旧 size 扫（多扫=保守安全）。
        // S1 = prev（块头地址，链表用 next 串在 HDR_NEXT），V4 遍历当前块。
        vm.lea(VReg.V2, "_heap_meta");
        vm.addImm(VReg.S1, VReg.V2, META_LARGE_FREE); // S1 = &large_free（当作虚拟前驱的 next 槽）
        // 约定：*(S1 + 0) 存链表头；对真实块 prev，next 在 HDR_NEXT(8)。
        // 为统一，用 offset 变量：头结点用 offset 0，块结点用 offset HDR_NEXT。
        vm.load(VReg.V4, VReg.S1, 0); // V4 = 当前块
        vm.movImm(VReg.S2, 0); // S2 = prevOffset（0 表示 prev 是 large_free 头）
        vm.movImm(VReg.V3, 0); // 扫描步数

        vm.label("_alloc_large_scan");
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_alloc_large_bump"); // 链表到底，走 bump
        // 扫描步数上限:多次 GC 后 large_free 链可达数十万项,first-fit 线性扫 ×
        // 编译器海量 concat 大块分配 = O(n²)(256MB 阈值自编译 10 分钟不终止的根因)。
        // 超限直接 bump——少量复用率换掉平方级卡死。
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.cmpImm(VReg.V3, 64);
        vm.jgt("_alloc_large_bump");
        // 读该块可用用户区大小 = header.size
        vm.load(VReg.V5, VReg.V4, HDR_FLAGS_SIZE);
        vm.shrImm(VReg.V5, VReg.V5, SIZE_SHIFT); // V5 = 块用户区字节
        vm.cmp(VReg.V5, VReg.S0);
        vm.jge("_alloc_large_reuse"); // 够大 → 复用
        // 不够：prev = 当前块，next = 当前块.next
        vm.mov(VReg.S1, VReg.V4);
        vm.movImm(VReg.S2, HDR_NEXT);
        vm.load(VReg.V4, VReg.V4, HDR_NEXT);
        vm.jmp("_alloc_large_scan");

        vm.label("_alloc_large_reuse");
        // 从链表摘除 V4：*(prev + prevOffset) = V4.next
        vm.load(VReg.V6, VReg.V4, HDR_NEXT); // V6 = V4.next
        // prev 地址 = S1，偏移 = S2（0 或 HDR_NEXT）
        vm.add(VReg.V7, VReg.S1, VReg.S2);
        vm.store(VReg.V7, 0, VReg.V6);
        // 清 next（标记已分配）
        vm.movImm(VReg.V6, 0);
        vm.store(VReg.V4, HDR_NEXT, VReg.V6);
        // 更新 alloc_count
        vm.lea(VReg.V2, "_heap_meta");
        vm.load(VReg.V5, VReg.V2, META_ALLOC_COUNT);
        vm.addImm(VReg.V5, VReg.V5, 1);
        vm.store(VReg.V2, META_ALLOC_COUNT, VReg.V5);
        // 清零复用块用户区 [user, user+旧 size)（旧 size 即 GC 扫描区间；见小对象路径注释）
        vm.load(VReg.V1, VReg.V4, HDR_FLAGS_SIZE);
        vm.shrImm(VReg.V1, VReg.V1, SIZE_SHIFT); // 旧 size
        vm.addImm(VReg.V5, VReg.V4, HEADER_SIZE); // cur
        vm.add(VReg.V6, VReg.V5, VReg.V1); // end
        vm.movImm(VReg.V7, 0);
        vm.label("_alloc_large_zloop");
        vm.cmp(VReg.V5, VReg.V6);
        vm.jge("_alloc_large_zdone");
        vm.store(VReg.V5, 0, VReg.V7);
        vm.addImm(VReg.V5, VReg.V5, 8);
        vm.jmp("_alloc_large_zloop");
        vm.label("_alloc_large_zdone");
        vm.addImm(VReg.RET, VReg.V4, HEADER_SIZE);
        vm.jmp("_alloc_setstart"); // 统一尾部:登记块起始 bit 后返回

        vm.label("_alloc_large_bump");
        vm.addImm(VReg.S3, VReg.S0, HEADER_SIZE); // S3 = total size

        // [M4] GOMAXPROCS>1:大对象直取全局 `_heap_ptr`,须与 mcache refill 同锁串行化
        // (S1/S2 在大对象 scan 结束后已死,借 S2 跨解锁保活 RET)。单 M 走 _do 直路。
        if (isParallel) {
            vm.lea(VReg.V0, "_gomaxprocs");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, 1);
            vm.jle("_alloc_large_bump_do");
            vm.lea(VReg.A0, "_mheap_lock");
            vm.call("_spin_lock");
            vm.mov(VReg.A0, VReg.S3);
            vm.call("_bump_alloc");
            vm.mov(VReg.S2, VReg.RET);
            vm.lea(VReg.A0, "_mheap_lock");
            vm.call("_spin_unlock");
            vm.mov(VReg.RET, VReg.S2);
            vm.jmp("_alloc_large_bump_done");
        }
        vm.label("_alloc_large_bump_do");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_bump_alloc");
        vm.label("_alloc_large_bump_done");

        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_alloc_fail");

        vm.mov(VReg.V4, VReg.RET); // V4 = 块头地址

        // 初始化对象头: flags_and_size = size << 16 | LARGE_CLASS << 6
        vm.shl(VReg.V5, VReg.S0, SIZE_SHIFT);
        vm.movImm(VReg.V6, LARGE_CLASS << CLASS_SHIFT);
        vm.or(VReg.V5, VReg.V5, VReg.V6);
        vm.store(VReg.V4, HDR_FLAGS_SIZE, VReg.V5);

        // next = 0
        vm.movImm(VReg.V5, 0);
        vm.store(VReg.V4, HDR_NEXT, VReg.V5);

        // 更新 alloc_count
        vm.lea(VReg.V2, "_heap_meta");
        vm.load(VReg.V5, VReg.V2, META_ALLOC_COUNT);
        vm.addImm(VReg.V5, VReg.V5, 1);
        vm.store(VReg.V2, META_ALLOC_COUNT, VReg.V5);

        // 返回用户数据区
        vm.addImm(VReg.RET, VReg.V4, HEADER_SIZE);
        vm.jmp("_alloc_setstart"); // 统一尾部:登记块起始 bit 后返回

        // ========== 统一成功尾部:块起始位图登记 ==========
        // RET = 用户区指针。置 startmap 中 (块-heap_base)>>3 位。
        // mark_one 靠此图把内部指针解析回真容器起始(见 heap_init 注释)。
        // 只用 V1-V6(x64 上 V0=RAX=RET,避开)。
        vm.label("_alloc_setstart");
        vm.lea(VReg.V1, "_heap_meta");
        vm.load(VReg.V2, VReg.V1, META_HEAP_BASE);
        vm.subImm(VReg.V3, VReg.RET, HEADER_SIZE); // block
        vm.sub(VReg.V3, VReg.V3, VReg.V2); // off
        vm.shrImm(VReg.V3, VReg.V3, 3); // bitIdx
        vm.shrImm(VReg.V4, VReg.V3, 6);
        vm.shlImm(VReg.V4, VReg.V4, 3); // word 字节偏移
        vm.andImm(VReg.V5, VReg.V3, 63);
        vm.movImm(VReg.V6, 1);
        vm.shl(VReg.V6, VReg.V6, VReg.V5); // bit mask
        vm.lea(VReg.V1, "_gc_startmap_base");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.add(VReg.V1, VReg.V1, VReg.V4);
        vm.load(VReg.V2, VReg.V1, 0);
        vm.or(VReg.V2, VReg.V2, VReg.V6);
        vm.store(VReg.V1, 0, VReg.V2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // ========== 分配失败 ==========
        vm.label("_alloc_fail");
        const allocFailMsg = "FATAL: Memory allocation failed in _alloc\n";
        vm.lea(VReg.A1, this.vm.asm.addString(allocFailMsg));
        vm.movImm(VReg.A2, allocFailMsg.length);
        vm.movImm(VReg.A0, 1);
        if (this.vm.platform === "wasi") {
            vm.syscall(1);
            vm.movImm(VReg.A0, 1);
            vm.syscall(60);
        } else if (this.vm.arch === "arm64") {
            vm.syscall(this.vm.platform === "linux" ? 64 : 4);
            vm.movImm(VReg.A0, 1);
            vm.syscall(this.vm.platform === "linux" ? 93 : 1);
        } else {
            vm.syscall(this.vm.platform === "linux" ? 1 : 0x2000004);
            vm.movImm(VReg.A0, 1);
            vm.syscall(this.vm.platform === "linux" ? 60 : 0x2000001);
        }
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _bump_alloc: 从堆末尾 bump 分配
    // A0 = 请求大小（包括头）
    // 返回: RET = 块头地址，0 表示失败
    generateBumpAlloc() {
        const vm = this.vm;

        vm.label("_bump_alloc");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // S0 = total size

        // 加载当前 heap_ptr
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V2, VReg.V1, 0); // V2 = current ptr

        // 计算新指针
        vm.add(VReg.V3, VReg.V2, VReg.S0); // V3 = new ptr

        // 检查是否超出堆边界
        vm.lea(VReg.V4, "_heap_meta");
        vm.load(VReg.V5, VReg.V4, META_HEAP_BASE);
        vm.load(VReg.V6, VReg.V4, META_HEAP_SIZE);
        vm.add(VReg.V5, VReg.V5, VReg.V6); // V5 = heap end

        vm.cmp(VReg.V3, VReg.V5);
        vm.jgt("_bump_alloc_grow");

        // 更新 heap_ptr
        vm.label("_bump_alloc_ok");
        vm.lea(VReg.V1, "_heap_ptr");
        vm.store(VReg.V1, 0, VReg.V3);

        // 更新 heap_used
        vm.lea(VReg.V4, "_heap_meta");
        vm.load(VReg.V5, VReg.V4, META_HEAP_USED);
        vm.add(VReg.V5, VReg.V5, VReg.S0);
        vm.store(VReg.V4, META_HEAP_USED, VReg.V5);
        // 维护峰值(诊断):peak = max(peak, heap_used)
        vm.load(VReg.V6, VReg.V4, META_HEAP_PEAK);
        vm.cmp(VReg.V5, VReg.V6);
        vm.jle("_bump_peak_ok");
        vm.store(VReg.V4, META_HEAP_PEAK, VReg.V5);
        vm.label("_bump_peak_ok");

        // 返回块头地址
        vm.mov(VReg.RET, VReg.V2);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // 需要扩展堆
        vm.label("_bump_alloc_grow");
        vm.mov(VReg.A0, VReg.S0); // 需要的大小
        vm.call("_heap_grow");

        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_bump_alloc_fail");

        // 扩展成功，重新加载 heap_ptr 并重试
        vm.lea(VReg.V1, "_heap_ptr");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.add(VReg.V3, VReg.V2, VReg.S0);
        vm.jmp("_bump_alloc_ok");

        vm.label("_bump_alloc_fail");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [M4/M5] _mcache_refill(A0=class, A1=stride) -> RET = 新 span 首块(块头地址)。
    // GOMAXPROCS>1 小对象 mcache 耗尽/空时的慢路:锁保护下从全局堆游标切一段 64KB 对齐 span,
    // 设当前 M 的 P 的 mc_cur[class]=base+stride、mc_end[class]=base+usable,返回首块。
    // 仅 linux-arm64 发射(真 spinlock/atomics 在 parallel_sched.js)。
    //
    // [M5 tail-sentinel discipline] 对齐策略镜像全局 `_alloc_span_new`:从 heap_ptr(expected)
    // 算 aligned=ceil64k(expected)、gap=aligned-expected(gap<HEADER 则挪一页保证哨兵可写),
    // reserve **恰好 gap+SPAN**(无 post-region)、在 [expected, aligned) 写 gap 哨兵(class=63)、
    // 置 pagemap[(aligned-heap_base)>>16]=class+1。这样 span 首块=aligned、其后每次分配经
    // 共享尾 `_alloc_span_hdr` 写 [mc_cur, page_end) 尾哨兵 → 整段自 heap_base 到 heap_ptr
    // **sweep 线性可走 + mark O(1) pagemap 可解析**,是启用多 M STW GC 的前提(§4-M5 剩余①)。
    // 后续 refill 的 expected 已 64k 对齐(前一 span 恰填至 page_end)→ gap=0,连续无洞。
    // `_bump_alloc` 在锁内调用 → heap_ptr 读改独占;28GB 初始堆下 bump 恒返 expected(无重定位)。
    generateMcacheRefill() {
        const vm = this.vm;
        if (!(vm.platform === "linux" && vm.arch === "arm64")) return;
        vm.label("_mcache_refill");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // class
        vm.mov(VReg.S1, VReg.A1); // stride
        // [M5] 分配慢路停点:refill 是天然停点(未持锁、不在协程栈内 → 现在停 GC 才安全)。
        // 在取 _mheap_lock **之前** poll(避免持锁 park → 死结);class/stride 已存 S0/S1 保活。
        vm.call("_safepoint_poll");
        vm.lea(VReg.A0, "_mheap_lock");
        vm.call("_spin_lock");
        // expected = heap_ptr(锁内独占读)
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.S2, VReg.V0, 0); // S2 = expected raw(bump 恒返此)
        // aligned = (expected + SPAN-1) & ~0xFFFF
        vm.movImm64(VReg.V0, BigInt(SPAN_SIZE - 1));
        vm.add(VReg.V1, VReg.S2, VReg.V0);
        vm.movImm64(VReg.V0, 0xffffffffffff0000n);
        vm.and(VReg.S3, VReg.V1, VReg.V0); // S3 = aligned span 首块
        // gap = aligned - expected;gap∈(0,HEADER) 容不下哨兵头 → 挪一页(gap+=SPAN)
        vm.sub(VReg.V6, VReg.S3, VReg.S2);
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_mcr_gapok");
        vm.cmpImm(VReg.V6, HEADER_SIZE);
        vm.jge("_mcr_gapok");
        vm.movImm64(VReg.V0, BigInt(SPAN_SIZE));
        vm.add(VReg.S3, VReg.S3, VReg.V0);
        vm.label("_mcr_gapok");
        // req = (aligned - expected) + SPAN
        vm.sub(VReg.V6, VReg.S3, VReg.S2);
        vm.movImm64(VReg.V0, BigInt(SPAN_SIZE));
        vm.add(VReg.A0, VReg.V6, VReg.V0);
        vm.call("_bump_alloc"); // RET = 预留段起点;锁内 → 游标推进独占
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_mcr_fail");
        // 28GB 堆下 bump 恒返 expected(无 heap_grow 重定位)。防御:不等则退化为无哨兵单 span
        // (回收会漏走该 span,但此路径在初始堆下不可达)。
        vm.cmp(VReg.RET, VReg.S2);
        vm.jne("_mcr_reloc");
        // ---- gap 哨兵:[expected, aligned) 若 gap>0 ----
        vm.sub(VReg.V6, VReg.S3, VReg.S2); // gap
        vm.cmpImm(VReg.V6, 0);
        vm.jeq("_mcr_nogap");
        vm.subImm(VReg.V0, VReg.V6, HEADER_SIZE);
        vm.shlImm(VReg.V0, VReg.V0, SIZE_SHIFT);
        vm.movImm(VReg.V3, SPAN_SENTINEL_CLASS << CLASS_SHIFT);
        vm.or(VReg.V0, VReg.V0, VReg.V3);
        vm.store(VReg.S2, 0, VReg.V0); // 哨兵 flags 在 expected(raw)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.S2, HDR_NEXT, VReg.V0); // 哨兵 next=0
        vm.label("_mcr_nogap");
        // ---- pagemap[(aligned - heap_base)>>16] = class+1(mark O(1) 解析)----
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V0, VReg.V0, META_HEAP_BASE);
        vm.sub(VReg.V3, VReg.S3, VReg.V0);
        vm.shrImm(VReg.V3, VReg.V3, SPAN_SHIFT);
        vm.lea(VReg.V0, "_gc_pagemap_base");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.add(VReg.V0, VReg.V0, VReg.V3);
        vm.addImm(VReg.V3, VReg.S0, 1);
        vm.storeByte(VReg.V0, 0, VReg.V3);
        // ---- 设 P.mc_cur/mc_end ----
        vm.label("_mcr_setcur");
        vm.lea(VReg.V2, "_m_current_p");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.shl(VReg.V3, VReg.S0, 3);
        vm.add(VReg.V4, VReg.V2, VReg.V3); // V4 = P + class*8
        // mc_end[class] = base + spanusable[class]
        vm.lea(VReg.V0, "_gc_spanusable");
        vm.add(VReg.V0, VReg.V0, VReg.V3);
        vm.load(VReg.V0, VReg.V0, 0);
        vm.add(VReg.V0, VReg.S3, VReg.V0);
        vm.store(VReg.V4, P_MC_END, VReg.V0);
        // mc_cur[class] = base + stride
        vm.add(VReg.V0, VReg.S3, VReg.S1);
        vm.store(VReg.V4, P_MC_CUR, VReg.V0);
        vm.lea(VReg.A0, "_mheap_lock");
        vm.call("_spin_unlock");
        vm.mov(VReg.RET, VReg.S3); // 首块 = span 基址
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        // ---- 重定位兜底(28GB 堆下不可达):RET=实际基址,aligned=ceil64k(RET),无 gap 哨兵/pagemap
        vm.label("_mcr_reloc");
        vm.movImm64(VReg.V2, BigInt(SPAN_SIZE - 1)); // (x64 V2==A2 无活值;V0≡RET 会盖掉实际基址)
        vm.add(VReg.V1, VReg.RET, VReg.V2);
        vm.movImm64(VReg.V0, 0xffffffffffff0000n);
        vm.and(VReg.S3, VReg.V1, VReg.V0); // S3 = aligned(from actual base)
        vm.jmp("_mcr_setcur");
        // ---- OOM 兜底:解锁返 0(调用者继而崩=真 OOM)----
        vm.label("_mcr_fail");
        vm.lea(VReg.A0, "_mheap_lock");
        vm.call("_spin_unlock");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _heap_grow: 扩展堆
    // A0 = 最小需要的额外空间
    // 返回: RET = 1 成功, 0 失败
    generateHeapGrow() {
        const vm = this.vm;
        const platform = vm.platform;

        vm.label("_heap_grow");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        // 计算需要扩展的大小（至少 HEAP_GROW_SIZE，向上对齐到页大小）
        vm.mov(VReg.S0, VReg.A0); // S0 = 本次分配需要的字节数
        vm.movImm(VReg.V1, HEAP_GROW_SIZE);
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_heap_grow_calc");
        vm.mov(VReg.S0, VReg.V1);

        vm.label("_heap_grow_calc");
        // 对齐到页大小 (4KB)
        vm.addImm(VReg.S0, VReg.S0, 4095);
        vm.movImm(VReg.V1, -4096);
        vm.and(VReg.S0, VReg.S0, VReg.V1); // S0 = 对齐后的扩展大小

        // 检查是否超过最大堆限制
        // (MAX_HEAP_SIZE == 0 表示无限制)
        if (MAX_HEAP_SIZE > 0) {
            // new_total = heap_size + grow_size；超限则失败
            vm.lea(VReg.V1, "_heap_meta");
            vm.load(VReg.V2, VReg.V1, META_HEAP_SIZE);
            vm.add(VReg.V2, VReg.V2, VReg.S0); // V2 = 扩展后总大小
            vm.movImm(VReg.V3, MAX_HEAP_SIZE);
            vm.cmp(VReg.V2, VReg.V3);
            vm.jgt("_heap_grow_fail");
        }

        // 调用 mmap 分配新内存
        // 用当前堆末尾作为地址 hint（非 MAP_FIXED，内核可能放到别处）。
        // 成功后必须校验 RET 是否 == current_end：
        //   - 相等：堆连续，线性延展 heap_size；
        //   - 不等：mmap 把新段放到别处，重定位 bump 指针到新段基址，
        //     否则会把 old_end→new_mapping 之间的未映射空洞地址发给用户 → SIGSEGV/SIGBUS。

        if (platform === "windows") {
            vm.movImm(VReg.A0, 0);
            vm.mov(VReg.A1, VReg.S0);
            vm.movImm(VReg.A2, 0x3000);
            vm.movImm(VReg.A3, 0x04);
            vm.callWindowsAPI(0);
        } else {
            // 获取当前堆的末尾地址作为 preferred address
            vm.lea(VReg.V1, "_heap_meta");
            vm.load(VReg.A0, VReg.V1, META_HEAP_BASE);
            vm.load(VReg.V3, VReg.V1, META_HEAP_SIZE);
            vm.add(VReg.A0, VReg.A0, VReg.V3); // A0 = current_end

            vm.mov(VReg.A1, VReg.S0); // size
            vm.movImm(VReg.A2, 3); // PROT_READ | PROT_WRITE
            vm.movImm(VReg.A3, this.getMmapFlags());
            vm.movImm(VReg.A4, -1);
            vm.movImm(VReg.A5, 0);
            vm.syscall(this.getSyscallNum("mmap"));
        }

        // 保存 mmap 返回值（新映射段基址），后续 RET 会被覆盖
        vm.mov(VReg.S1, VReg.RET);

        // 检查是否成功 (windows 失败=0, unix 失败=-1/MAP_FAILED)
        vm.movImm(VReg.V1, platform === "windows" ? 0 : -1);
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_heap_grow_fail");

        // 计算旧堆末尾 current_end = heap_base + heap_size
        vm.lea(VReg.S2, "_heap_meta");
        vm.load(VReg.V1, VReg.S2, META_HEAP_BASE);
        vm.load(VReg.V2, VReg.S2, META_HEAP_SIZE);
        vm.add(VReg.V1, VReg.V1, VReg.V2); // V1 = current_end

        // 若 mmap 返回值 == current_end，则堆连续，线性延展
        vm.cmp(VReg.S1, VReg.V1);
        vm.jeq("_heap_grow_extend");

        // 否则 mmap 把新段放到了别处：重定位到新段，避免发出未映射空洞地址
        // heap_base = RET（新段基址）
        vm.store(VReg.S2, META_HEAP_BASE, VReg.S1);
        // heap_size = 本次扩展大小（新段容量），bump 边界检查相对新段
        vm.store(VReg.S2, META_HEAP_SIZE, VReg.S0);
        // heap_used = 0（新段从头开始；旧段剩余空间放弃）
        vm.movImm(VReg.V2, 0);
        vm.store(VReg.S2, META_HEAP_USED, VReg.V2);
        // 关键：把 bump 指针重定位到新段基址；否则 _bump_alloc 重试时
        // 仍从旧 _heap_ptr 线性延展，切出 old_end→new_mapping 的未映射空洞。
        vm.lea(VReg.V3, "_heap_ptr");
        vm.store(VReg.V3, 0, VReg.S1);
        vm.jmp("_heap_grow_ok");

        // 连续扩展：heap_size += grow_size，_heap_ptr 保持不变（继续线性 bump）
        vm.label("_heap_grow_extend");
        vm.load(VReg.V3, VReg.S2, META_HEAP_SIZE);
        vm.add(VReg.V3, VReg.V3, VReg.S0);
        vm.store(VReg.S2, META_HEAP_SIZE, VReg.V3);

        vm.label("_heap_grow_ok");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        vm.label("_heap_grow_fail");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _get_size_class: 根据大小返回 size class 索引
    // A0 = 对齐后的请求大小
    // 返回: RET = class index (0-17)
    generateGetSizeClass() {
        const vm = this.vm;

        vm.label("_get_size_class");
        vm.prologue(0, []);

        // 简化实现：使用分段判断
        // class 0: 8
        vm.cmpImm(VReg.A0, 8);
        vm.jle("_size_class_0");
        // class 1: 16
        vm.cmpImm(VReg.A0, 16);
        vm.jle("_size_class_1");
        // class 2: 24
        vm.cmpImm(VReg.A0, 24);
        vm.jle("_size_class_2");
        // class 3: 32
        vm.cmpImm(VReg.A0, 32);
        vm.jle("_size_class_3");
        // class 4: 48
        vm.cmpImm(VReg.A0, 48);
        vm.jle("_size_class_4");
        // class 5: 64
        vm.cmpImm(VReg.A0, 64);
        vm.jle("_size_class_5");
        // class 6: 80
        vm.cmpImm(VReg.A0, 80);
        vm.jle("_size_class_6");
        // class 7: 96
        vm.cmpImm(VReg.A0, 96);
        vm.jle("_size_class_7");
        // class 8: 112
        vm.cmpImm(VReg.A0, 112);
        vm.jle("_size_class_8");
        // class 9: 128
        vm.cmpImm(VReg.A0, 128);
        vm.jle("_size_class_9");
        // class 10: 160
        vm.cmpImm(VReg.A0, 160);
        vm.jle("_size_class_10");
        // class 11: 192
        vm.cmpImm(VReg.A0, 192);
        vm.jle("_size_class_11");
        // class 12: 224
        vm.cmpImm(VReg.A0, 224);
        vm.jle("_size_class_12");
        // class 13: 256
        vm.cmpImm(VReg.A0, 256);
        vm.jle("_size_class_13");
        // class 14: 320
        vm.cmpImm(VReg.A0, 320);
        vm.jle("_size_class_14");
        // class 15: 384
        vm.cmpImm(VReg.A0, 384);
        vm.jle("_size_class_15");
        // class 16: 448
        vm.cmpImm(VReg.A0, 448);
        vm.jle("_size_class_16");
        // class 17: 512
        vm.movImm(VReg.RET, 17);
        vm.epilogue([], 0);

        for (let i = 0; i <= 16; i++) {
            vm.label(`_size_class_${i}`);
            vm.movImm(VReg.RET, i);
            vm.epilogue([], 0);
        }
    }

    // _get_class_size: 根据 size class 索引返回该类的实际大小
    // A0 = class index
    // 返回: RET = class size
    generateGetClassSize() {
        const vm = this.vm;

        vm.label("_get_class_size");
        vm.prologue(0, []);

        // 使用跳转表或分段判断
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_class_size_0");
        vm.cmpImm(VReg.A0, 1);
        vm.jeq("_class_size_1");
        vm.cmpImm(VReg.A0, 2);
        vm.jeq("_class_size_2");
        vm.cmpImm(VReg.A0, 3);
        vm.jeq("_class_size_3");
        vm.cmpImm(VReg.A0, 4);
        vm.jeq("_class_size_4");
        vm.cmpImm(VReg.A0, 5);
        vm.jeq("_class_size_5");
        vm.cmpImm(VReg.A0, 6);
        vm.jeq("_class_size_6");
        vm.cmpImm(VReg.A0, 7);
        vm.jeq("_class_size_7");
        vm.cmpImm(VReg.A0, 8);
        vm.jeq("_class_size_8");
        vm.cmpImm(VReg.A0, 9);
        vm.jeq("_class_size_9");
        vm.cmpImm(VReg.A0, 10);
        vm.jeq("_class_size_10");
        vm.cmpImm(VReg.A0, 11);
        vm.jeq("_class_size_11");
        vm.cmpImm(VReg.A0, 12);
        vm.jeq("_class_size_12");
        vm.cmpImm(VReg.A0, 13);
        vm.jeq("_class_size_13");
        vm.cmpImm(VReg.A0, 14);
        vm.jeq("_class_size_14");
        vm.cmpImm(VReg.A0, 15);
        vm.jeq("_class_size_15");
        vm.cmpImm(VReg.A0, 16);
        vm.jeq("_class_size_16");
        // default: class 17
        vm.movImm(VReg.RET, 512);
        vm.epilogue([], 0);

        const sizes = SIZE_CLASSES;
        for (let i = 0; i <= 16; i++) {
            vm.label(`_class_size_${i}`);
            vm.movImm(VReg.RET, sizes[i]);
            vm.epilogue([], 0);
        }
    }

    // _free: 释放内存（放回对应的 free list）
    // A0 = 用户数据区地址
    generateFree() {
        const vm = this.vm;

        vm.label("_free");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        // 检查 NULL
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_free_done");

        // 计算块头地址
        vm.subImm(VReg.S0, VReg.A0, HEADER_SIZE); // S0 = header addr

        // 读取 flags_and_size
        vm.load(VReg.V0, VReg.S0, HDR_FLAGS_SIZE);

        // 提取 size class
        vm.shr(VReg.V1, VReg.V0, CLASS_SHIFT);
        vm.movImm(VReg.V2, CLASS_MASK);
        vm.and(VReg.S1, VReg.V1, VReg.V2); // S1 = size class

        // 检查是否为大对象
        vm.cmpImm(VReg.S1, LARGE_CLASS);
        vm.jeq("_free_large");

        // 小对象：放入对应的 free list
        vm.lea(VReg.V2, "_heap_meta");
        vm.shl(VReg.V3, VReg.S1, 3);
        vm.addImm(VReg.V3, VReg.V3, META_FREE_LISTS);
        vm.add(VReg.V3, VReg.V2, VReg.V3); // V3 = &free_lists[class]

        // 链表插入头部
        vm.load(VReg.V4, VReg.V3, 0); // V4 = old head
        vm.store(VReg.S0, HDR_NEXT, VReg.V4); // block.next = old head
        vm.store(VReg.V3, 0, VReg.S0); // free_lists[class] = block

        vm.jmp("_free_done");

        // 大对象：放入 large_free 链表
        vm.label("_free_large");
        vm.lea(VReg.V2, "_heap_meta");
        vm.load(VReg.V3, VReg.V2, META_LARGE_FREE);
        vm.store(VReg.S0, HDR_NEXT, VReg.V3);
        vm.store(VReg.V2, META_LARGE_FREE, VReg.S0);

        vm.label("_free_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _gc_push_gray(A0=user ptr):无条件压入标记栈(不判重)。minor GC 用它强制
    // 重扫已标记(old)容器/box 的内容——drain 弹栈扫描不检查标记位(判重在 mark_one
    // 入栈侧),故 old 容器的 young 新值得以标记。满则置 _gc_overflow(触发 rescan)。
    // 叶子裸函数,只用 V1-V4。
    generateGcPushGray() {
        const vm = this.vm;
        vm.label("_gc_push_gray");
        vm.lea(VReg.V1, "_gc_mstack_top");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.lea(VReg.V3, "_gc_mstack_cap");
        vm.load(VReg.V3, VReg.V3, 0);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jlt("_gcpg_store");
        vm.lea(VReg.V1, "_gc_overflow");
        vm.movImm(VReg.V2, 1);
        vm.store(VReg.V1, 0, VReg.V2);
        vm.ret();
        vm.label("_gcpg_store");
        vm.lea(VReg.V3, "_gc_mstack_base");
        vm.load(VReg.V3, VReg.V3, 0);
        vm.shl(VReg.V4, VReg.V2, 3);
        vm.add(VReg.V3, VReg.V3, VReg.V4);
        vm.store(VReg.V3, 0, VReg.A0);
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.store(VReg.V1, 0, VReg.V2);
        vm.ret();
    }

    // _gc_collect_minor():分代 minor GC(sticky mark-bit)。与 full 的差异:
    // 不清位图(老对象保持已标,drain 对其 O(1) 跳过——不重扫老对象图);
    // 根 = 常规根 + 全部登记 box + 记忆集容器(mark_one 置位 + push_gray 强制重扫);
    // sweep 只走 young 段且不清 free_lists。调用前提:_rs_overflow==0(调度处保证)。
    generateGcCollectMinor() {
        const vm = this.vm;
        vm.label("_gc_collect_minor");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.lea(VReg.V0, "_heap_meta");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, META_GC_RUNNING, VReg.V1);
        vm.lea(VReg.V0, "_gc_mstack_top");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_overflow");
        vm.store(VReg.V0, 0, VReg.V1);

        // 常规根(栈/寄存器缓存/数据段)
        vm.call("_gc_mark_roots");

        // box 登记表:每个 box 置位(young box 防被 sweep)+ 强制重扫内容
        vm.lea(VReg.S0, "_box_reg_base");
        vm.load(VReg.S0, VReg.S0, 0);
        vm.lea(VReg.S1, "_box_reg_top");
        vm.load(VReg.S1, VReg.S1, 0);
        vm.shl(VReg.S1, VReg.S1, 3);
        vm.add(VReg.S1, VReg.S0, VReg.S1); // end
        vm.label("_gcm_box_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcm_box_done");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_gc_mark_one");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_gc_push_gray");
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gcm_box_loop");
        vm.label("_gcm_box_done");

        // 记忆集:老容器置位(幂等)+ 强制重扫内容
        vm.lea(VReg.S0, "_rs_base");
        vm.load(VReg.S0, VReg.S0, 0);
        vm.lea(VReg.S1, "_rs_top");
        vm.load(VReg.S1, VReg.S1, 0);
        vm.shl(VReg.S1, VReg.S1, 3);
        vm.add(VReg.S1, VReg.S0, VReg.S1);
        vm.label("_gcm_rs_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcm_rs_done");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_gc_scan_container"); // 容器+间接存储块(data_ptr/props_ptr)都重扫
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gcm_rs_loop");
        vm.label("_gcm_rs_done");

        // drain(+溢出 rescan,同 full)
        vm.label("_gcm_drain");
        vm.call("_gc_drain");
        vm.lea(VReg.V0, "_gc_overflow");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_gcm_sweep");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_gc_rescan_overflow");
        vm.jmp("_gcm_drain");

        vm.label("_gcm_sweep");
        vm.call("_gc_sweep_young");

        // gc_count++;分代状态推进
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_GC_COUNT);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.V0, META_GC_COUNT, VReg.V1);
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.lea(VReg.V0, "_gc_last_ptr");
        vm.store(VReg.V0, 0, VReg.V1); // young 起点推进(存活者晋升 old)
        vm.call("_rs_clear_dedup"); // 清 RS 去重位(须在 rs_top=0 前)
        vm.movImm(VReg.V1, 0);
        vm.lea(VReg.V0, "_rs_top");
        vm.store(VReg.V0, 0, VReg.V1); // 记忆集清空(下一代边由屏障重新捕获)
        vm.lea(VReg.V0, "_gc_alloc_since");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_heap_meta");
        vm.store(VReg.V0, META_GC_RUNNING, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // _gc_scan_container(A0=裸容器 user 指针):minor/shadow 的记忆集条目处理——
    // mark_one+push_gray 容器本体,并按类型字节展开「间接存储块」同样两连:
    // 数组(type=1)的 data_ptr@24、对象(type=2)的 props_ptr@32。
    // 动机(影子模式实测):元素/属性存于间接块,old 间接块已标 → mark_one no-op →
    // drain 不重扫 → old 容器新写入的 young 值漏标(SHADOW-MISS 全是此类)。
    generateGcScanContainer() {
        const vm = this.vm;
        vm.label("_gc_scan_container");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_gc_mark_one");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_push_gray");
        // 类型感知间接块
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 1); // TYPE_ARRAY
        vm.jeq("_gcsc_arr");
        vm.cmpImm(VReg.V1, 2); // TYPE_OBJECT
        vm.jeq("_gcsc_obj");
        vm.cmpImm(VReg.V1, 4); // TYPE_MAP
        vm.jeq("_gcsc_chain");
        vm.cmpImm(VReg.V1, 5); // TYPE_SET
        vm.jeq("_gcsc_chain");
        vm.cmpImm(VReg.V1, 12); // TYPE_ARRAY_BUFFER [Design B]
        vm.jeq("_gcsc_abuf");
        vm.cmpImm(VReg.V1, 0x40); // [Design A] TypedArray 族(0x40-0x61)
        vm.jge("_gcsc_abuf");     // 同 abuf:标记 buffer@24(视图的底层 buffer,GC 根)
        vm.jmp("_gcsc_done");
        // [Design A/B] wrapper ArrayBuffer 的 owner@24 / TypedArray 视图的 buffer@24:
        // 标记令其存活,防 buffer/DataView/视图 存活期间底层被回收 → data_ptr 悬垂。
        // own-data buffer 与内联未缓存 TypedArray 的 @24 = 0(跳过)。
        vm.label("_gcsc_abuf");
        vm.load(VReg.A0, VReg.S0, 24); // owner / buffer
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcsc_done");
        vm.call("_gc_mark_one");
        vm.jmp("_gcsc_done");
        vm.label("_gcsc_arr");
        vm.load(VReg.S0, VReg.S0, 24); // data_ptr
        vm.jmp("_gcsc_ind");
        vm.label("_gcsc_obj");
        // [#61 P2] per-property flags 块 @40(叶子,无外向指针,只需标记存活)。
        // old 对象 materialize 后 flags 块为 young,写点屏障已把对象记入 RS,此处
        // 标记令其存活。_gc_mark_one 保存 S0(容器),调用后 S0 仍是容器。
        vm.load(VReg.A0, VReg.S0, 40); // flags_ptr
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcsc_obj_props");
        vm.call("_gc_mark_one"); // S0 由 mark_one 保存
        vm.label("_gcsc_obj_props");
        vm.load(VReg.S0, VReg.S0, 32); // props_ptr
        vm.label("_gcsc_ind");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_gcsc_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_mark_one");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_push_gray");
        vm.jmp("_gcsc_done");

        // Map/Set:链式结构——old 尾节点的 next 被写向 young 新节点,重扫容器头
        // 不够(head/tail 只覆盖端点,中间 old 节点的 next 边漏)。全链逐节点
        // push_gray(节点 32B:key/value/next/hnext 都被重扫)+ 桶数组(bucket[i]
        // 被写入新链头,同 array data 性质)。链长=size,minor 代价可接受。
        vm.label("_gcsc_chain");
        // 桶数组 @40
        vm.load(VReg.A0, VReg.S0, 40);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcsc_chain_nodes");
        vm.push(VReg.A0);
        vm.call("_gc_mark_one");
        vm.pop(VReg.A0);
        vm.call("_gc_push_gray");
        vm.label("_gcsc_chain_nodes");
        vm.load(VReg.S0, VReg.S0, 16); // head
        vm.label("_gcsc_node_loop");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_gcsc_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_mark_one");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_push_gray");
        vm.load(VReg.S0, VReg.S0, 16); // node.next
        vm.jmp("_gcsc_node_loop");

        vm.label("_gcsc_done");
        vm.epilogue([VReg.S0], 0);
    }

    // [GC_SHADOW] _gc_collect_shadow():影子模式——minor-mark 后把 young 位图段
    // 快照到影子区,清位图跑 full-mark,逐 young 块对照:full 标记而影子未标记 =
    // minor 漏标(屏障/根覆盖缺口),打印块偏移+头(头含类型字节可辨写点)。
    // 回收始终按 full 走,正确性不受影子影响。minor 完备性的显微镜。
    generateGcCollectShadow() {
        const vm = this.vm;
        vm.label("_gc_collect_shadow");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.lea(VReg.V0, "_heap_meta");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, META_GC_RUNNING, VReg.V1);
        vm.lea(VReg.V0, "_gc_mstack_top");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_overflow");
        vm.store(VReg.V0, 0, VReg.V1);

        // [GC_SHADOW_BISECT] 二分诊断:跳过阶段1/2/4,只走 清位图→full-mark→sweep。
        // 理论上与 _gc_collect 等价;若仍崩则 3/5/尾部有隐差,若不崩则阶段1/2 有副作用。
        if (process.env.GC_SHADOW_BISECT) {
            vm.lea(VReg.S4, "_gc_bitmap_base"); // 阶段3 依赖阶段2 装载的 S4
            vm.load(VReg.S4, VReg.S4, 0);
            vm.jmp("_gcsh_ph3");
        }

        // ===== 阶段1:minor mark(不 sweep)=====
        vm.call("_gc_mark_roots");
        vm.lea(VReg.S0, "_box_reg_base");
        vm.load(VReg.S0, VReg.S0, 0);
        vm.lea(VReg.S1, "_box_reg_top");
        vm.load(VReg.S1, VReg.S1, 0);
        vm.shl(VReg.S1, VReg.S1, 3);
        vm.add(VReg.S1, VReg.S0, VReg.S1);
        vm.label("_gcsh_box_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcsh_box_done");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_gc_mark_one");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_gc_push_gray");
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gcsh_box_loop");
        vm.label("_gcsh_box_done");
        vm.lea(VReg.S0, "_rs_base");
        vm.load(VReg.S0, VReg.S0, 0);
        vm.lea(VReg.S1, "_rs_top");
        vm.load(VReg.S1, VReg.S1, 0);
        vm.shl(VReg.S1, VReg.S1, 3);
        vm.add(VReg.S1, VReg.S0, VReg.S1);
        vm.label("_gcsh_rs_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcsh_rs_done");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_gc_scan_container"); // 容器+间接存储块都重扫
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gcsh_rs_loop");
        vm.label("_gcsh_rs_done");
        vm.label("_gcsh_drain1");
        vm.call("_gc_drain");
        vm.lea(VReg.V0, "_gc_overflow");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_gcsh_snap");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_gc_rescan_overflow");
        vm.jmp("_gcsh_drain1");

        // ===== 阶段2:快照 young 位图段 =====
        vm.label("_gcsh_snap");
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.S0, VReg.V0, META_HEAP_BASE);
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.add(VReg.S1, VReg.S0, VReg.V1);
        vm.lea(VReg.V0, "_gc_last_ptr");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.sub(VReg.S2, VReg.S2, VReg.S0);
        vm.shrImm(VReg.S2, VReg.S2, 6);
        vm.movImm64(VReg.V1, 0xfffffffffffffff8n);
        vm.and(VReg.S2, VReg.S2, VReg.V1);
        vm.sub(VReg.S3, VReg.S1, VReg.S0);
        vm.shrImm(VReg.S3, VReg.S3, 6);
        vm.addImm(VReg.S3, VReg.S3, 16);
        vm.lea(VReg.S4, "_gc_bitmap_base");
        vm.load(VReg.S4, VReg.S4, 0);
        vm.lea(VReg.S5, "_shadow_base");
        vm.load(VReg.S5, VReg.S5, 0);
        vm.sub(VReg.S5, VReg.S5, VReg.S2);
        vm.store(VReg.SP, 8, VReg.S5);
        vm.label("_gcsh_copy");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_gcsh_copy_done");
        vm.add(VReg.V0, VReg.S4, VReg.S2);
        vm.load(VReg.V1, VReg.V0, 0);
        vm.add(VReg.V0, VReg.S5, VReg.S2);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.addImm(VReg.S2, VReg.S2, 8);
        vm.jmp("_gcsh_copy");
        vm.label("_gcsh_copy_done");

        // ===== 阶段3:清位图 + full mark =====
        vm.label("_gcsh_ph3");
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.shrImm(VReg.V1, VReg.V1, 6);
        vm.addImm(VReg.V1, VReg.V1, 16);
        vm.movImm64(VReg.V6, BigInt(this.bitmapSize));
        vm.cmp(VReg.V1, VReg.V6);
        vm.jle("_gcsh_bmz_ok");
        vm.mov(VReg.V1, VReg.V6);
        vm.label("_gcsh_bmz_ok");
        vm.movImm(VReg.V3, 0);
        vm.movImm(VReg.V5, 0);
        vm.label("_gcsh_bmz");
        vm.cmp(VReg.V3, VReg.V1);
        vm.jge("_gcsh_bmz_done");
        vm.add(VReg.V4, VReg.S4, VReg.V3);
        vm.store(VReg.V4, 0, VReg.V5);
        vm.addImm(VReg.V3, VReg.V3, 8);
        vm.jmp("_gcsh_bmz");
        vm.label("_gcsh_bmz_done");
        vm.lea(VReg.V0, "_gc_mstack_top");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_gc_mark_roots");
        vm.label("_gcsh_drain2");
        vm.call("_gc_drain");
        vm.lea(VReg.V0, "_gc_overflow");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_gcsh_cmp");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_gc_rescan_overflow");
        vm.jmp("_gcsh_drain2");

        // ===== 阶段4:逐 young 块对照 =====
        vm.label("_gcsh_cmp");
        if (process.env.GC_SHADOW_BISECT) {
            vm.jmp("_gcsh_cmp_done"); // 二分:阶段2 未跑,[SP+8] 未初始化,跳过对照
        }
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.load(VReg.V0, VReg.V0, META_HEAP_BASE);
        vm.add(VReg.S1, VReg.V0, VReg.V1);
        vm.store(VReg.SP, 16, VReg.V0);
        vm.lea(VReg.S0, "_gc_last_ptr");
        vm.load(VReg.S0, VReg.S0, 0);
        vm.load(VReg.S5, VReg.SP, 8);
        vm.label("_gcsh_cmp_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcsh_cmp_done");
        vm.load(VReg.V0, VReg.S0, HDR_FLAGS_SIZE);
        vm.shrImm(VReg.S2, VReg.V0, SIZE_SHIFT);
        vm.shrImm(VReg.V1, VReg.V0, CLASS_SHIFT);
        vm.andImm(VReg.V1, VReg.V1, 0x3ff);
        vm.cmpImm(VReg.V1, SPAN_SENTINEL_CLASS);
        vm.jeq("_gcsh_cmp_large"); // 哨兵与大对象同式:footprint=size+16
        vm.movImm(VReg.V1, MAX_SMALL_SIZE);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jgt("_gcsh_cmp_large");
        vm.shrImm(VReg.V0, VReg.S2, 3);
        vm.lea(VReg.V1, "_gc_s2c");
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.loadByte(VReg.S3, VReg.V1, 0);
        vm.lea(VReg.V1, "_gc_c2s");
        vm.shl(VReg.V0, VReg.S3, 3);
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V1, 0);
        vm.addImm(VReg.S3, VReg.V0, HEADER_SIZE);
        vm.jmp("_gcsh_cmp_bits");
        vm.label("_gcsh_cmp_large");
        vm.addImm(VReg.S3, VReg.S2, HEADER_SIZE);

        vm.label("_gcsh_cmp_bits");
        vm.add(VReg.V0, VReg.S0, VReg.S3);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jgt("_gcsh_cmp_done");
        vm.load(VReg.V1, VReg.SP, 16);
        vm.sub(VReg.V0, VReg.S0, VReg.V1);
        vm.shrImm(VReg.V0, VReg.V0, 3);
        vm.shrImm(VReg.V1, VReg.V0, 6);
        vm.shlImm(VReg.V1, VReg.V1, 3);
        vm.andImm(VReg.V2, VReg.V0, 63);
        vm.movImm(VReg.V3, 1);
        vm.shl(VReg.V3, VReg.V3, VReg.V2);
        vm.add(VReg.V4, VReg.S4, VReg.V1);
        vm.load(VReg.V4, VReg.V4, 0);
        vm.and(VReg.V4, VReg.V4, VReg.V3);
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_gcsh_cmp_next");
        vm.add(VReg.V4, VReg.S5, VReg.V1);
        vm.load(VReg.V4, VReg.V4, 0);
        vm.and(VReg.V4, VReg.V4, VReg.V3);
        vm.cmpImm(VReg.V4, 0);
        vm.jne("_gcsh_cmp_next");
        // MISS
        vm.lea(VReg.V0, "_shadow_miss");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.A0, this.vm.asm.addString("SHADOW-MISS off="));
        vm.call("_print_str_no_nl");
        vm.load(VReg.V1, VReg.SP, 16);
        vm.sub(VReg.A0, VReg.S0, VReg.V1);
        vm.call("_print_int_no_nl");
        vm.lea(VReg.A0, this.vm.asm.addString(" hdr="));
        vm.call("_print_str_no_nl");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_print_int");

        vm.label("_gcsh_cmp_next");
        vm.add(VReg.S0, VReg.S0, VReg.S3);
        vm.jmp("_gcsh_cmp_loop");
        vm.label("_gcsh_cmp_done");

        // ===== 阶段5:full sweep + 尾部 =====
        vm.call("_gc_sweep");
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_GC_COUNT);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.V0, META_GC_COUNT, VReg.V1);
        vm.lea(VReg.V0, "_gc_alloc_since");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.lea(VReg.V0, "_gc_last_ptr");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_rs_clear_dedup"); // 清 RS 去重位(须在 rs_top=0 前)
        vm.movImm(VReg.V1, 0);
        vm.lea(VReg.V0, "_rs_top");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_rs_overflow");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_heap_meta");
        vm.store(VReg.V0, META_GC_RUNNING, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 32);
    }

    // _gc_sweep_young():minor 专用 sweep——只走 [_gc_last_ptr, heap_end),
    // 不清 free_lists(只追加 young 死块;老链保留)。内循环与 _gc_sweep 同构(零 call)。
    generateGcSweepYoung() {
        const vm = this.vm;
        vm.label("_gc_sweep_young");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.S0, VReg.V0, META_HEAP_BASE);
        vm.store(VReg.SP, 0, VReg.S0); // [SP+0] = heap_base(位图偏移计算)
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.add(VReg.S1, VReg.S0, VReg.V1); // S1 = heap_end
        vm.lea(VReg.S0, "_gc_last_ptr");
        vm.load(VReg.S0, VReg.S0, 0); // S0 = cur = young 起点
        vm.lea(VReg.S4, "_gc_bitmap_base");
        vm.load(VReg.S4, VReg.S4, 0);

        vm.label("_gcsy_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcsy_done");
        vm.load(VReg.V0, VReg.S0, HDR_FLAGS_SIZE);
        vm.shrImm(VReg.S2, VReg.V0, SIZE_SHIFT);
        vm.shrImm(VReg.V1, VReg.V0, CLASS_SHIFT);
        vm.andImm(VReg.V1, VReg.V1, 0x3ff);
        vm.cmpImm(VReg.V1, SPAN_SENTINEL_CLASS);
        vm.jne("_gcsy_notsent");
        vm.addImm(VReg.S5, VReg.S2, HEADER_SIZE);
        vm.movImm(VReg.S3, -2);
        vm.jmp("_gcsy_check");
        vm.label("_gcsy_notsent");
        vm.movImm(VReg.V1, MAX_SMALL_SIZE);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jgt("_gcsy_large_calc");
        vm.shrImm(VReg.V0, VReg.S2, 3);
        vm.lea(VReg.V1, "_gc_s2c");
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.loadByte(VReg.S3, VReg.V1, 0);
        vm.lea(VReg.V1, "_gc_c2s");
        vm.shl(VReg.V0, VReg.S3, 3);
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V1, 0);
        vm.addImm(VReg.S5, VReg.V0, HEADER_SIZE);
        vm.jmp("_gcsy_check");
        vm.label("_gcsy_large_calc");
        vm.addImm(VReg.S5, VReg.S2, HEADER_SIZE);
        vm.movImm(VReg.S3, -1);

        vm.label("_gcsy_check");
        vm.add(VReg.V0, VReg.S0, VReg.S5);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jgt("_gcsy_done");

        vm.load(VReg.V1, VReg.SP, 0);
        vm.sub(VReg.V0, VReg.S0, VReg.V1);
        vm.shrImm(VReg.V0, VReg.V0, 3);
        vm.shrImm(VReg.V1, VReg.V0, 6);
        vm.shlImm(VReg.V1, VReg.V1, 3);
        vm.andImm(VReg.V2, VReg.V0, 63);
        vm.movImm(VReg.V3, 1);
        vm.shl(VReg.V3, VReg.V3, VReg.V2);
        vm.add(VReg.V1, VReg.S4, VReg.V1);
        vm.load(VReg.V1, VReg.V1, 0);
        vm.and(VReg.V1, VReg.V1, VReg.V3);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_gcsy_advance"); // 存活:保持标记(sticky)即晋升 old

        // 未标记:挂 free-list(追加,不清旧链)
        vm.cmpImm(VReg.S3, -2);
        vm.jeq("_gcsy_advance"); // 哨兵:不挂链
        vm.cmpImm(VReg.S3, -1);
        vm.jeq("_gcsy_free_large");
        vm.lea(VReg.V0, "_heap_meta");
        vm.shl(VReg.V1, VReg.S3, 3);
        vm.addImm(VReg.V1, VReg.V1, META_FREE_LISTS);
        vm.add(VReg.V1, VReg.V0, VReg.V1);
        vm.load(VReg.V2, VReg.V1, 0);
        vm.store(VReg.S0, HDR_NEXT, VReg.V2);
        vm.store(VReg.V1, 0, VReg.S0);
        vm.jmp("_gcsy_advance");
        vm.label("_gcsy_free_large");
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V2, VReg.V0, META_LARGE_FREE);
        vm.store(VReg.S0, HDR_NEXT, VReg.V2);
        vm.store(VReg.V0, META_LARGE_FREE, VReg.S0);

        vm.label("_gcsy_advance");
        vm.add(VReg.S0, VReg.S0, VReg.S5);
        vm.jmp("_gcsy_loop");

        vm.label("_gcsy_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
    }

    // ==================== 分代 GC 基建(#11 阶段b) ====================
    // _box_alloc() -> box 指针(8B 用户区)。分配 + 登记到 _box_reg。
    // minor GC 把全部登记 box 直接喂入 mark 栈(drain 扫 box[0] 内容),
    // 结构性覆盖「老 box 被编译器内联写入 young 值」的边,免写屏障。
    // 登记满(800 万 box)置 rs_overflow → minor 退化 full(保守安全)。
    generateBoxAlloc() {
        const vm = this.vm;
        vm.label("_box_alloc");
        vm.prologue(0, [VReg.S0]);
        vm.movImm(VReg.A0, 8);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.lea(VReg.V1, "_box_reg_top");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.movImm64(VReg.V3, BigInt(8 * 1024 * 1024)); // 上限条数(64MB/8)
        vm.cmp(VReg.V2, VReg.V3);
        vm.jlt("_box_alloc_reg");
        // 登记满:置溢出旗,box 照常返回(minor 将退化 full)
        vm.lea(VReg.V1, "_rs_overflow");
        vm.movImm(VReg.V2, 1);
        vm.store(VReg.V1, 0, VReg.V2);
        vm.jmp("_box_alloc_done");
        vm.label("_box_alloc_reg");
        vm.lea(VReg.V3, "_box_reg_base");
        vm.load(VReg.V3, VReg.V3, 0);
        vm.shl(VReg.V4, VReg.V2, 3);
        vm.add(VReg.V3, VReg.V3, VReg.V4);
        vm.store(VReg.V3, 0, VReg.S0); // reg[top] = box
        vm.addImm(VReg.V2, VReg.V2, 1);
        vm.store(VReg.V1, 0, VReg.V2); // top++
        vm.label("_box_alloc_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);
    }

    // _gc_remember(A0=容器块用户区指针或装箱值)。写点屏障:目标容器是 old
    // (块地址 < _gc_last_ptr)时记入记忆集;young 容器毋需记录(minor 本来会扫)。
    // 记忆集满置溢出旗(minor 退化 full)。装箱值先脱壳。
    generateGcRemember() {
        const vm = this.vm;
        vm.label("_gc_remember");
        // 叶子裸函数(无 prologue):只用 V0-V5(caller-saved),不碰栈/FP/LR。
        // 调用纪律:必须在宿主函数「A 参就位、V 未启用」的开头调用。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V1); // 脱壳
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_gc_rem_done");
        // old 判定:块 < last_ptr(用户区指针-16=块头;直接用用户区指针比较即可,
        // 误差 16B 只影响 young/old 边界一个块,young 误记无害)
        vm.lea(VReg.V6, "_gc_last_ptr");
        vm.load(VReg.V6, VReg.V6, 0);
        vm.cmp(VReg.V0, VReg.V6);
        vm.jge("_gc_rem_done"); // young → 不记
        vm.lea(VReg.V6, "_rs_top");
        vm.load(VReg.V3, VReg.V6, 0);
        vm.movImm64(VReg.V4, BigInt(16 * 1024 * 1024)); // 上限条数(128MB/8)
        vm.cmp(VReg.V3, VReg.V4);
        vm.jlt("_gc_rem_store");
        vm.lea(VReg.V6, "_rs_overflow");
        vm.movImm(VReg.V3, 1);
        vm.store(VReg.V6, 0, VReg.V3);
        vm.jmp("_gc_rem_done");
        vm.label("_gc_rem_store");
        // ---- 容器级去重(独立位图,1 bit/8B 块起始)----
        // 无去重时每次 _map_set/_object_set 都追加 RS,minor 对每条目做全容器扫描
        // (Map 还走全链)→ 热容器 O(写次数×容器大小) 平方爆炸(256MB 阈值自编译
        // >15min 的根因)。test-and-set:已记过的容器本轮直接跳过。
        // 位只在真正 append 时置(溢出丢弃的条目不置位,否则位无人清 → 永久漏记)。
        // 寄存器纪律:V0=payload、V3=top、V6=&rs_top 需保活;V2/V7 是 x64 参数别名
        // 禁用;可用 V1/V4/V5,V3 用后从 [V6] 重载。
        vm.lea(VReg.V1, "_heap_meta");
        vm.load(VReg.V1, VReg.V1, META_HEAP_BASE);
        vm.subImm(VReg.V4, VReg.V0, HEADER_SIZE);
        vm.sub(VReg.V4, VReg.V4, VReg.V1); // 块偏移
        vm.shrImm(VReg.V4, VReg.V4, 3); // bitIdx
        vm.shrImm(VReg.V5, VReg.V4, 6);
        vm.shlImm(VReg.V5, VReg.V5, 3); // word 字节偏移
        vm.andImm(VReg.V4, VReg.V4, 63);
        vm.movImm(VReg.V1, 1);
        vm.shl(VReg.V1, VReg.V1, VReg.V4); // V1 = bit mask
        vm.lea(VReg.V4, "_rs_dedup_base");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.add(VReg.V4, VReg.V4, VReg.V5); // V4 = word 地址
        vm.load(VReg.V5, VReg.V4, 0); // V5 = word
        vm.and(VReg.V3, VReg.V5, VReg.V1); // V3 牺牲(下面从 [V6] 重载 top)
        vm.cmpImm(VReg.V3, 0);
        vm.jne("_gc_rem_done"); // 本轮已记过 → 跳过
        vm.or(VReg.V5, VReg.V5, VReg.V1);
        vm.store(VReg.V4, 0, VReg.V5); // 置位
        vm.load(VReg.V3, VReg.V6, 0); // 重载 top
        vm.lea(VReg.V4, "_rs_base");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.shl(VReg.V5, VReg.V3, 3);
        vm.add(VReg.V4, VReg.V4, VReg.V5);
        vm.store(VReg.V4, 0, VReg.V0); // rs[top] = 容器(裸用户区指针)
        vm.addImm(VReg.V3, VReg.V3, 1);
        vm.store(VReg.V6, 0, VReg.V3);
        vm.label("_gc_rem_done");
        vm.ret();
    }

    // _rs_clear_dedup():按 RS 条目清去重位(下一轮屏障可重新记忆)。
    // 各 GC 尾部在 rs_top=0 之前调用。O(|RS|),RS 已去重故很小。
    generateRsClearDedup() {
        const vm = this.vm;
        vm.label("_rs_clear_dedup");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.lea(VReg.V0, "_rs_base");
        vm.load(VReg.S0, VReg.V0, 0);
        vm.lea(VReg.V0, "_rs_top");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.shl(VReg.V1, VReg.V1, 3);
        vm.add(VReg.S1, VReg.S0, VReg.V1); // S1 = end
        vm.lea(VReg.V2, "_heap_meta");
        vm.load(VReg.V2, VReg.V2, META_HEAP_BASE);
        vm.lea(VReg.V3, "_rs_dedup_base");
        vm.load(VReg.V3, VReg.V3, 0);
        vm.label("_rscd_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_rscd_done");
        vm.load(VReg.V4, VReg.S0, 0); // 容器 user 指针
        vm.subImm(VReg.V4, VReg.V4, HEADER_SIZE);
        vm.sub(VReg.V4, VReg.V4, VReg.V2);
        vm.shrImm(VReg.V4, VReg.V4, 3); // bitIdx
        vm.shrImm(VReg.V5, VReg.V4, 6);
        vm.shlImm(VReg.V5, VReg.V5, 3);
        vm.andImm(VReg.V4, VReg.V4, 63);
        vm.movImm(VReg.V6, 1);
        vm.shl(VReg.V6, VReg.V6, VReg.V4);
        vm.not(VReg.V6, VReg.V6); // ~mask
        vm.add(VReg.V7, VReg.V3, VReg.V5);
        vm.load(VReg.V5, VReg.V7, 0);
        vm.and(VReg.V5, VReg.V5, VReg.V6);
        vm.store(VReg.V7, 0, VReg.V5); // 清位
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_rscd_loop");
        vm.label("_rscd_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // 生成所有 allocator 相关代码
    // [引擎库 P0 执行器基元 smoke]:mmap 一页可执行内存,写入 arm64 `mov x0,#42; ret`
    // (LE 64 位字 0xD65F03C0D2800540),callIndirect 跳入,返回 42(裸 int)。验证
    // 进程内"字节→执行→取回"闭环。先试纯 RWX(prot=7);macOS 若禁 RWX 需 MAP_JIT 等。
    generateEngineSmoke() {
        const vm = this.vm;
        vm.label("_engine_smoke_exec");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        // mmap RW(prot=3):macOS 禁 writable+exec(RWX 返 EACCES),故先 RW 再 mprotect RX。
        vm.movImm(VReg.A0, 0);
        vm.movImm(VReg.A1, 4096);
        vm.movImm(VReg.A2, 3); // PROT_READ|WRITE
        vm.movImm(VReg.A3, this.getMmapFlags());
        vm.movImm64(VReg.A4, 0xffffffffffffffffn); // fd = -1
        vm.movImm(VReg.A5, 0);
        vm.syscall(this.getSyscallNum("mmap"));
        vm.mov(VReg.S0, VReg.RET); // mem
        // 失败判据:< 4096(捕 -1 与 macOS errno 风格小值如 EACCES=13)
        vm.cmpImm(VReg.S0, 4096);
        vm.jlt("_engine_smoke_fail");
        // 写码:mov x0,#42 (0xD2800540) ; ret (0xD65F03C0)
        vm.movImm64(VReg.V0, 0xD65F03C0D2800540n);
        vm.store(VReg.S0, 0, VReg.V0);
        // mprotect(mem, 4096, PROT_READ|EXEC=5):W^X 翻转为可执行(macos arm64 syscall 74)
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 4096);
        vm.movImm(VReg.A2, 5); // PROT_READ|EXEC
        const mprotectNum = (vm.platform === "linux")
            ? (vm.arch === "arm64" ? 226 : 10)
            : (vm.arch === "arm64" ? 74 : 0x2000000 + 74);
        vm.syscall(mprotectNum);
        // mprotect 失败(<0/非0)→ 返回哨兵 -998
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_engine_smoke_fail2");
        // (首测省 I-cache 刷新:全新页 VA 无 stale icache;崩再补 dc cvau/ic ivau。)
        vm.callIndirect(VReg.S0); // BLR mem → RET = 42
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_engine_smoke_fail");
        vm.movImm64(VReg.RET, 0xfffffffffffffc19n); // -999 (mmap 失败)
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_engine_smoke_fail2");
        vm.movImm64(VReg.RET, 0xfffffffffffffc1an); // -998 (mprotect 失败)
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [引擎库 P0.1] _engine_exec(A0=codePtr 源机器码字节首址, A1=codeLen 字节数) -> RET。
    // mmap RW 一页 → memcpy codeLen 字节 → mprotect RX(W^X 翻转)→ callIndirect 跳入取回。
    // 泛化 smoke:接真实代码缓冲(JS 侧从 Uint8Array 取 data 指针+长度)。假设 codeLen<4096。
    generateEngineExec() {
        const vm = this.vm;
        vm.label("_engine_exec");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A0); // src codePtr
        vm.mov(VReg.S2, VReg.A1); // codeLen
        // mmap RW
        vm.movImm(VReg.A0, 0);
        vm.movImm(VReg.A1, 4096);
        vm.movImm(VReg.A2, 3); // R|W
        vm.movImm(VReg.A3, this.getMmapFlags());
        vm.movImm64(VReg.A4, 0xffffffffffffffffn);
        vm.movImm(VReg.A5, 0);
        vm.syscall(this.getSyscallNum("mmap"));
        vm.mov(VReg.S0, VReg.RET); // mem
        vm.cmpImm(VReg.S0, 4096);
        vm.jlt("_engine_exec_fail");
        // memcpy codeLen 字节 src(S1) → mem(S0)
        vm.movImm(VReg.S3, 0); // i
        vm.label("_engine_exec_cpy");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_engine_exec_cpydone");
        vm.add(VReg.V1, VReg.S1, VReg.S3);
        vm.loadByte(VReg.V0, VReg.V1, 0);
        vm.add(VReg.V1, VReg.S0, VReg.S3);
        vm.storeByte(VReg.V1, 0, VReg.V0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_engine_exec_cpy");
        vm.label("_engine_exec_cpydone");
        // I-cache 刷新(防陈旧执行 SIGILL)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_engine_iflush");
        // mprotect RX
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 4096);
        vm.movImm(VReg.A2, 5); // R|X
        const mpNum = (vm.platform === "linux") ? (vm.arch === "arm64" ? 226 : 10)
            : (vm.arch === "arm64" ? 74 : 0x2000000 + 74);
        vm.syscall(mpNum);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_engine_exec_fail");
        vm.callIndirect(VReg.S0); // BLR mem → RET
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_engine_exec_fail");
        vm.movImm64(VReg.RET, 0xfffffffffffffc17n); // -1001
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // [引擎库 P1] _engine_symaddr(A0=symId) -> 宿主运行时符号地址(lea 经 PC-relative
    // 解析,post-ASLR 正确)。小符号表:id → 运行时 helper。fragment 的 bl 重定位据此
    // 填 trampoline 的 addr_slot。新符号在此加 case + 同步 engine/compile.js 的 SYM_IDS。
    generateEngineSymaddr() {
        const vm = this.vm;
        const syms = [
            "_number_coerce", "_js_add", "_valueToStr", "_strconcat",
            "_object_get_ic", "_subscript_get", "_math_sqrt",
            // 与 engine/compile.js SYM_IDS 严格同序:位运算 / 布尔强制 / 关系比较 / Math。
            "_js_band", "_js_bor", "_js_bxor", "_js_bshl", "_js_bshr", "_js_bushr",
            "_to_boolean", "_js_relcmp",
            "_math_abs", "_math_floor", "_math_ceil", "_math_round", "_math_pow",
            // 宿主可变数据全局:lea 取宿主地址(数据 label),供片段 ldr-literal 槽运行时填。
            "_heap_base", "_heap_ptr",
            // 抽象相等(动态 ==)、数值→字符串(concat 内联数字渲染)。
            "_abstract_eq", "_floatToString",
            // 分配类(数组/对象字面量,走宿主共享堆)。
            "_array_new_with_size", "_array_set", "_object_new_sized", "_object_define",
            // 长度 / typeof / 装箱字符串 / 数组 join。
            "_js_length", "_js_box_string", "_js_typeof", "_array_join", "_array_to_string",
            // 常用字符串方法。
            "_str_toUpperCase", "_str_toLowerCase", "_str_slice", "_str_indexOf",
            "_str_charCodeAt", "_str_split", "_str_trim", "_str_substring",
            "_str_repeat", "_str_includes", "_str_replace",
            "_js_unbox", "_array_length", "_getStrContent", "_typeof", "_to_int32",
            // 对象属性读 NO_IC 形态(片段:站点回填写 RX 页崩,改走此二者无写回)。
            "_object_get", "_maybe_getter",
            // 关系比较 < <= > >=。
            "_js_lt", "_js_le", "_js_gt", "_js_ge",
            // 更多 Math。
            "_math_trunc", "_math_cbrt",
            // 更多字符串方法。
            "_str_padStart", "_str_padEnd", "_str_at", "_str_charAt",
            "_str_startsWith", "_str_endsWith", "_str_replaceAll",
            // 更多数组方法(无闭包)。
            "_array_push", "_array_get", "_array_reverse", "_array_slice",
            "_array_includes", "_array_indexOf", "_array_at", "_array_flat",
            // 对数/指数 Math;异常展开;数值解析/转换。
            "_math_log", "_math_log2", "_math_log10", "_math_exp",
            "_throw_unwind", "_js_parseInt", "_js_parseFloat", "_str_to_num",
            // toString(radix)/toFixed;sort 比较;lastIndexOf;instanceof。
            "_is_bigint", "_num_toFixed", "_strcmp", "_str_lastIndexOf", "_instanceof",
            // toString(radix);sort/元素写回;异常状态全局(HOST_DATA,adrp 重定位)。
            "_num_toString", "_subscript_set", "_exception_value", "_exception_pending",
            // 闭包/回调类(P7:eval 内函数/箭头表达式)。
            "_typed_array_new", "_alloc",
            // 闭包调用/回调体内常见:async 分支、===、sort 比较器归一。
            "_coroutine_create", "_strict_eq", "_syscall_arg",
            // 直接闭包调用(IIFE)的 async 分支(dead 但内联发射)。
            "_promise_new", "_scheduler_spawn",
            // 闭包捕获外层 eval 局部(装箱共享 box);TDZ 未初始化读错误路径。
            "_box_alloc", "_print_str",
            // try/catch 异常上下文链头(HOST_DATA);for-of 字符串迭代 codePointAt。
            "_exc_ctx_top", "_str_codepoint_at",
            // throw new Error(建对象);for-of 迭代器的字符串/Map 分支(数组不取但内联发射)。
            "_object_new", "_object_set", "_str_cp_bytes", "_map_entries",
            // 属性键装箱 tag helper(成员写 o.k=v / 方法调用 a.push():emitBoxedStringKey 的
            // A1 键 |= STRING_TAG)。片段捕获对象/数组经成员写/方法变异必经。
            "_tag_str_a1", "_tag_key_a1",
            // 动态方法调用可调用性校验(a.push()/o.f() 取属性后校验)。
            "_validate_callable",
            // 数组变异簇(捕获数组经方法变异;均为 array/index.js 恒发射 live 实现)。
            "_array_pop", "_array_shift", "_array_unshift", "_array_splice",
            "_array_concat",
            // 数组结果装箱(eval 内数组方法闭包收尾装箱新数组)。
            "_box_arr_r",
            // for-of IteratorClose(提前 break/error 时调 iterator.return())
            "_iterator_close",
            "_box_obj_r",
        ];
        vm.label("_engine_symaddr");
        vm.prologue(0, []);
        for (let i = 0; i < syms.length; i++) {
            vm.cmpImm(VReg.A0, i);
            vm.jne("_esym_" + (i + 1));
            vm.lea(VReg.RET, syms[i]);
            vm.epilogue([], 0);
            vm.label("_esym_" + (i + 1));
        }
        vm.movImm(VReg.RET, 0); // 未知 id → 0
        vm.epilogue([], 0);
    }

    // [引擎库 P1] _engine_reloc_exec(A0=fragPtr, A1=fragLen, A2=relocPtr, A3=relocByteLen)
    // -> 执行结果。mmap RW → memcpy → 按 reloc(每条 8 字节:slotOff(4,LE)+symId(4,LE))
    // 用 _engine_symaddr(symId) 填 mem+slotOff 的 8 字节 addr_slot → mprotect RX → 跳入。
    generateEngineRelocExec() {
        const vm = this.vm;
        vm.label("_engine_reloc_exec");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A0); // fragPtr(src)
        vm.mov(VReg.S2, VReg.A1); // fragLen
        vm.mov(VReg.S4, VReg.A2); // relocPtr
        vm.mov(VReg.S5, VReg.A3); // relocByteLen
        // mmap RW —— 长度按 fragLen 向上取整到页倍数(多页片段:ADRP 页差已按缓冲偏移编码,
        // 故片段可 >4096;须映射足够页)。A1 = (fragLen + 4095) & ~4095。
        vm.movImm(VReg.A0, 0);
        vm.addImm(VReg.A1, VReg.S2, 4095);
        vm.movImm64(VReg.V0, 0xfffffffffffff000n);
        vm.and(VReg.A1, VReg.A1, VReg.V0);
        vm.movImm(VReg.A2, 3);
        vm.movImm(VReg.A3, this.getMmapFlags());
        vm.movImm64(VReg.A4, 0xffffffffffffffffn);
        vm.movImm(VReg.A5, 0);
        vm.syscall(this.getSyscallNum("mmap"));
        vm.mov(VReg.S0, VReg.RET); // mem
        vm.cmpImm(VReg.S0, 4096);
        vm.jlt("_engine_reloc_fail");
        // memcpy fragLen 字节 src(S1)→mem(S0)
        vm.movImm(VReg.S3, 0);
        vm.label("_erx_cpy");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_erx_cpydone");
        vm.add(VReg.V1, VReg.S1, VReg.S3);
        vm.loadByte(VReg.V0, VReg.V1, 0);
        vm.add(VReg.V1, VReg.S0, VReg.S3);
        vm.storeByte(VReg.V1, 0, VReg.V0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_erx_cpy");
        vm.label("_erx_cpydone");
        // 应用 reloc:i 字节游标(0..relocByteLen,步长 8)
        vm.movImm(VReg.S3, 0);
        vm.label("_erx_rel");
        vm.cmp(VReg.S3, VReg.S5);
        vm.jge("_erx_reldone");
        vm.add(VReg.V2, VReg.S4, VReg.S3); // &reloc[i]
        // slotOff = 4 字节 LE @0
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.loadByte(VReg.V1, VReg.V2, 1); vm.shl(VReg.V1, VReg.V1, 8); vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 2); vm.shl(VReg.V1, VReg.V1, 16); vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 3); vm.shl(VReg.V1, VReg.V1, 24); vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.push(VReg.V0); // slotOff 暂存(symaddr 调用会冲寄存器)
        // symId = 4 字节 LE @4
        vm.loadByte(VReg.A0, VReg.V2, 4);
        vm.loadByte(VReg.V1, VReg.V2, 5); vm.shl(VReg.V1, VReg.V1, 8); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 6); vm.shl(VReg.V1, VReg.V1, 16); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 7); vm.shl(VReg.V1, VReg.V1, 24); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_engine_symaddr"); // RET = 符号地址
        // x64:V0=RAX=RET 别名(见 runtime-helper-reg-contracts),下面 pop V0 会覆盖
        // symaddr 返回值(RAX)→ 把 slotOff 当地址写进 slot → trampoline jmp slotOff 崩。
        // 先把 RET 存入 V2(x64=RDX/arm64=X10,两架构均≠RET),再 pop/add/store 用 V2。
        vm.mov(VReg.V2, VReg.RET); // V2 = 符号地址(保存,躲开 pop V0 对 RET 的覆盖)
        vm.pop(VReg.V0); // slotOff
        vm.add(VReg.V1, VReg.S0, VReg.V0); // mem + slotOff
        vm.store(VReg.V1, 0, VReg.V2);     // 写 8 字节地址
        vm.addImm(VReg.S3, VReg.S3, 8);
        vm.jmp("_erx_rel");
        vm.label("_erx_reldone");
        // I-cache 刷新(写码后必需,防陈旧执行 SIGILL)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_engine_iflush");
        // mprotect RX —— 长度按 fragLen 向上取整到页倍数(多页片段;须与 mmap 同长)。
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S2, 4095);
        vm.movImm64(VReg.V0, 0xfffffffffffff000n);
        vm.and(VReg.A1, VReg.A1, VReg.V0);
        vm.movImm(VReg.A2, 5);
        const mpNum = (vm.platform === "linux") ? (vm.arch === "arm64" ? 226 : 10)
            : (vm.arch === "arm64" ? 74 : 0x2000000 + 74);
        vm.syscall(mpNum);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_engine_reloc_fail");
        vm.callIndirect(VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_engine_reloc_fail");
        vm.movImm64(VReg.RET, 0xfffffffffffffc13n); // -1005
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // [引擎库 · 直接 eval 词法捕获] _engine_reloc_exec_fp(A0=fragPtr, A1=fragLen, A2=relocPtr,
    // A3=relocByteLen, A4=callerFP) -> 执行结果。与 _engine_reloc_exec 同,唯一区别:把
    // callerFP(直接 eval 所在函数的运行时 FP)在跳入片段前置入 A0——片段入口据此 copy-in/
    // copy-out 外层局部(见 engine/compile.js compileFragment 的 capture 逻辑)。callerFP 于
    // 入口 push 保活(躲过 mmap/memcpy/reloc 对 A 寄存器的冲刷),每个 epilogue 前 pop 复衡 SP。
    generateEngineRelocExecFp() {
        const vm = this.vm;
        vm.label("_engine_reloc_exec_fp");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.push(VReg.A4);         // 保活 callerFP(16B 对齐 stpPre;各 epilogue 前 pop 复衡)
        vm.mov(VReg.S1, VReg.A0); // fragPtr(src)
        vm.mov(VReg.S2, VReg.A1); // fragLen
        vm.mov(VReg.S4, VReg.A2); // relocPtr
        vm.mov(VReg.S5, VReg.A3); // relocByteLen
        vm.movImm(VReg.A0, 0);
        vm.addImm(VReg.A1, VReg.S2, 4095);
        vm.movImm64(VReg.V0, 0xfffffffffffff000n);
        vm.and(VReg.A1, VReg.A1, VReg.V0);
        vm.movImm(VReg.A2, 3);
        vm.movImm(VReg.A3, this.getMmapFlags());
        vm.movImm64(VReg.A4, 0xffffffffffffffffn);
        vm.movImm(VReg.A5, 0);
        vm.syscall(this.getSyscallNum("mmap"));
        vm.mov(VReg.S0, VReg.RET); // mem
        vm.cmpImm(VReg.S0, 4096);
        vm.jlt("_engine_reloc_fp_fail");
        // memcpy fragLen 字节 src(S1)→mem(S0)
        vm.movImm(VReg.S3, 0);
        vm.label("_erxf_cpy");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_erxf_cpydone");
        vm.add(VReg.V1, VReg.S1, VReg.S3);
        vm.loadByte(VReg.V0, VReg.V1, 0);
        vm.add(VReg.V1, VReg.S0, VReg.S3);
        vm.storeByte(VReg.V1, 0, VReg.V0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_erxf_cpy");
        vm.label("_erxf_cpydone");
        // 应用 reloc(每条 8B:slotOff 4B LE + symId 4B LE)
        vm.movImm(VReg.S3, 0);
        vm.label("_erxf_rel");
        vm.cmp(VReg.S3, VReg.S5);
        vm.jge("_erxf_reldone");
        vm.add(VReg.V2, VReg.S4, VReg.S3);
        vm.loadByte(VReg.V0, VReg.V2, 0);
        vm.loadByte(VReg.V1, VReg.V2, 1); vm.shl(VReg.V1, VReg.V1, 8); vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 2); vm.shl(VReg.V1, VReg.V1, 16); vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 3); vm.shl(VReg.V1, VReg.V1, 24); vm.or(VReg.V0, VReg.V0, VReg.V1);
        vm.push(VReg.V0); // slotOff 暂存
        vm.loadByte(VReg.A0, VReg.V2, 4);
        vm.loadByte(VReg.V1, VReg.V2, 5); vm.shl(VReg.V1, VReg.V1, 8); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 6); vm.shl(VReg.V1, VReg.V1, 16); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.loadByte(VReg.V1, VReg.V2, 7); vm.shl(VReg.V1, VReg.V1, 24); vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.call("_engine_symaddr");
        vm.mov(VReg.V2, VReg.RET); // V2 = 符号地址(躲开 pop V0 对 RET 的覆盖,x64 别名)
        vm.pop(VReg.V0);           // slotOff
        vm.add(VReg.V1, VReg.S0, VReg.V0);
        vm.store(VReg.V1, 0, VReg.V2);
        vm.addImm(VReg.S3, VReg.S3, 8);
        vm.jmp("_erxf_rel");
        vm.label("_erxf_reldone");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_engine_iflush");
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.S2, 4095);
        vm.movImm64(VReg.V0, 0xfffffffffffff000n);
        vm.and(VReg.A1, VReg.A1, VReg.V0);
        vm.movImm(VReg.A2, 5);
        const mpNum = (vm.platform === "linux") ? (vm.arch === "arm64" ? 226 : 10)
            : (vm.arch === "arm64" ? 74 : 0x2000000 + 74);
        vm.syscall(mpNum);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_engine_reloc_fp_fail");
        vm.pop(VReg.A0);           // A0 = callerFP(复衡 SP;跳入片段前置入)
        vm.callIndirect(VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
        vm.label("_engine_reloc_fp_fail");
        vm.pop(VReg.A0);           // 复衡入口 push(SP 归位,供 epilogue 正确恢复 callee-saved)
        vm.movImm64(VReg.RET, 0xfffffffffffffc13n); // -1005
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // [引擎库] _engine_iflush(A0=addr, A1=len):刷 [addr,addr+len) 的 D-cache 到统一点 +
    // 失效 I-cache。写码后必调,否则复用 VA 的陈旧 I-cache 条目 → 执行旧字节 SIGILL
    // (自编译 eval:编译器大量分配后 mmap 页 VA 复用曾放代码处,realeval SIGILL 根因)。
    generateEngineIflush() {
        const vm = this.vm;
        vm.label("_engine_iflush");
        vm.prologue(0, []);
        vm.add(VReg.V1, VReg.A0, VReg.A1); // end
        vm.mov(VReg.V0, VReg.A0);
        vm.label("_eif_dc");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_eif_dcdone");
        vm.dcCvau(VReg.V0);
        vm.addImm(VReg.V0, VReg.V0, 64);
        vm.jmp("_eif_dc");
        vm.label("_eif_dcdone");
        vm.dsbIsh();
        vm.mov(VReg.V0, VReg.A0);
        vm.label("_eif_ic");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_eif_icdone");
        vm.icIvau(VReg.V0);
        vm.addImm(VReg.V0, VReg.V0, 64);
        vm.jmp("_eif_ic");
        vm.label("_eif_icdone");
        vm.dsbIsh();
        vm.isb();
        vm.epilogue([], 0);
    }

    generate() {
        this.generateEngineSmoke();
        this.generateEngineExec();
        this.generateEngineSymaddr();
        this.generateEngineIflush();
        this.generateEngineRelocExec();
        this.generateEngineRelocExecFp();
        this.generateHeapInit();
        this.generateGetSizeClass();
        this.generateGetClassSize();
        this.generateBumpAlloc();
        this.generateHeapGrow();
        this.generateAlloc();
        this.generateMcacheRefill(); // [M4] per-P mcache 慢路(锁保护 span carve),仅 linux-arm64
        this.generateFree();
        // ---- 保守式 mark-sweep GC ----
        this.generateGcIsHeapPtr();
        this.generateGcBlockFootprint();
        this.generateGcIsMarked();
        this.generateGcMarkOne();
        this.generateGcDrain();
        this.generateGcMarkRoots();
        this.generateGcScanStackRange(); // [M5] linux-arm64: STW 扩展根扫描辅助
        this.generateGcScanOtherMs();    // [M5] linux-arm64: 扫其它已 park M 的栈根
        this.generateGcRescanOverflow();
        this.generateGcSweep();
        // ---- 分代基建(#11 阶段b) ----
        this.generateBoxAlloc();
        this.generateGcRemember();
        this.generateRsClearDedup();
        this.generateGcPushGray();
        this.generateGcCollectMinor();
        this.generateGcSweepYoung();
        this.generateGcScanContainer();
        if (process.env.GC_SHADOW) {
            this.generateGcCollectShadow();
        }
        if (process.env.GC_DIAG) {
            this.generateGcDiagHex();
            this.generateGcDiagLine();
            this.generateGcDiagStartHelpers();
            this.generateGcDiagResolve();
            this.generateGcDiagCheck();
            this.generateGcDiag();
        }
        this.generateGcCollect();
        this.generateExit();
        if (process.env.ALLOC_DBG) {
            this.generateAllocDbg();
        }
    }

    // [ALLOC_DBG] 诊断探针：打印巨型分配的 size 与调用者 LR 后 abort。
    generateAllocDbg() {
        const vm = this.vm;
        const wr = this.vm.platform === "linux" ? 64 : 4;
        const puts = (s) => {
            vm.movImm(VReg.A0, 2);
            vm.lea(VReg.A1, this.vm.asm.addString(s));
            vm.movImm(VReg.A2, s.length);
            vm.syscall(wr);
        };

        // _alloc_dbg_hex(A0=value)：把 A0 的 16 位十六进制写到 fd2（复用 _gc_diag_buf）。
        vm.label("_alloc_dbg_hex");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.S1, 15);
        vm.label("_adh_loop");
        vm.andImm(VReg.V2, VReg.S0, 0xf);
        vm.cmpImm(VReg.V2, 10);
        vm.jlt("_adh_dig");
        vm.addImm(VReg.V2, VReg.V2, 0x27);
        vm.label("_adh_dig");
        vm.addImm(VReg.V2, VReg.V2, 0x30);
        vm.lea(VReg.V3, "_gc_diag_buf");
        vm.add(VReg.V3, VReg.V3, VReg.S1);
        vm.storeByte(VReg.V3, 0, VReg.V2);
        vm.shrImm(VReg.S0, VReg.S0, 4);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_adh_loop");
        vm.movImm(VReg.A0, 2);
        vm.lea(VReg.A1, "_gc_diag_buf");
        vm.movImm(VReg.A2, 16);
        vm.syscall(wr);
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _alloc_dbg_report(A0=size)：打印巨型分配的 size + 去 ASLR 后的静态帧链回溯，然后 exit(42)。
        // imp2 是 PIE，运行时地址 = 静态 VA + slide。_start 位于 __text 起始(静态 VA 0x100000370)，
        // lea(_start) 得到运行时 __text 基址，slide = lea(_start) - 0x100000370。
        // 打印时对每个运行时地址减去 slide → 直接是静态 VA，可用 dumplabels 解析。
        vm.label("_alloc_dbg_report");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        // S2 = slide = lea(_start) - 0x100000370
        vm.lea(VReg.V0, "_start");
        vm.movImm64(VReg.V1, 0x100000370n);
        vm.sub(VReg.S2, VReg.V0, VReg.V1);
        puts("\nBIGALLOC sz=");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_alloc_dbg_hex");
        puts(" lr=");
        vm.lea(VReg.V0, "_alloc_dbg_lr");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.sub(VReg.A0, VReg.A0, VReg.S2); // 去 slide → 静态 VA
        vm.call("_alloc_dbg_hex");
        puts("\n");
        // 帧链回溯（静态 VA）：从捕获的调用者帧指针(x29)沿链走，打印每层保存的返回地址([fp+8])。
        puts("bt(static):\n");
        vm.lea(VReg.V0, "_alloc_dbg_fp");
        vm.load(VReg.S0, VReg.V0, 0); // S0 = fp
        vm.movImm(VReg.S1, 16); // 最多 16 层
        vm.label("_adr_btloop");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_adr_btdone");
        vm.cmpImm(VReg.S1, 0);
        vm.jle("_adr_btdone");
        vm.load(VReg.A0, VReg.S0, 8); // saved LR（运行时）
        vm.sub(VReg.A0, VReg.A0, VReg.S2); // 去 slide → 静态 VA
        vm.call("_alloc_dbg_hex");
        puts("\n");
        vm.load(VReg.S0, VReg.S0, 0); // 下一帧 fp
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_adr_btloop");
        vm.label("_adr_btdone");
        vm.movImm(VReg.A0, 42);
        vm.call("_exit");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // _array_dbg_report(A0=array raw ptr, A1=needed)：巨型数组增长时 dump 数组头字段后 exit(43)。
        // 布局：type@0, length@8, capacity@16, data_ptr@24。判断是 length/capacity 被冲还是 arr 指针本身错。
        vm.label("_array_dbg_report");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // arr
        vm.mov(VReg.S1, VReg.A1); // needed
        puts("\nARRGROW arr=");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_alloc_dbg_hex");
        puts(" type=");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.call("_alloc_dbg_hex");
        puts(" len=");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_alloc_dbg_hex");
        puts(" cap=");
        vm.load(VReg.A0, VReg.S0, 16);
        vm.call("_alloc_dbg_hex");
        puts(" dptr=");
        vm.load(VReg.A0, VReg.S0, 24);
        vm.call("_alloc_dbg_hex");
        puts(" needed=");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_alloc_dbg_hex");
        puts("\n");
        vm.movImm(VReg.A0, 43);
        vm.call("_exit");
        vm.epilogue([VReg.S0, VReg.S1], 0);

        // _strhdr_dbg_report(A0=len, A1=caller frame ptr)：某字符串以巨型 length 建头时 dump + bt，exit(44)。
        vm.label("_strhdr_dbg_report");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // len
        vm.mov(VReg.S1, VReg.A1); // fp
        // slide = lea(_start) - 0x100000370
        vm.lea(VReg.V0, "_start");
        vm.movImm64(VReg.V1, 0x100000370n);
        vm.sub(VReg.S2, VReg.V0, VReg.V1);
        puts("\nSTRHDR len=");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_alloc_dbg_hex");
        puts("\nbt(static):\n");
        vm.movImm(VReg.A0, 16);
        vm.label("_shr_btloop");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_shr_btdone");
        vm.cmpImm(VReg.A0, 0);
        vm.jle("_shr_btdone");
        vm.push(VReg.A0); // save counter (A0 clobbered by hex)
        vm.load(VReg.A0, VReg.S1, 8); // saved LR
        vm.sub(VReg.A0, VReg.A0, VReg.S2);
        vm.call("_alloc_dbg_hex");
        puts("\n");
        vm.pop(VReg.A0);
        vm.subImm(VReg.A0, VReg.A0, 1);
        vm.load(VReg.S1, VReg.S1, 0); // next frame
        vm.jmp("_shr_btloop");
        vm.label("_shr_btdone");
        vm.movImm(VReg.A0, 44);
        vm.call("_exit");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // ==================== 保守式 mark-sweep GC ====================

    // _gc_is_heap_ptr(A0=value) -> RET = 用户指针 或 0
    // 保守判定：取低 48 位 payload；高 16 位 tag ∈ {0(裸指针),0x7ffc..0x7fff(串/对象/数组/函数)}
    // 且 payload 8 对齐、落在 [heap_base+HEADER_SIZE, heap_base+heap_used] 内 → 返回 payload。
    generateGcIsHeapPtr() {
        const vm = this.vm;
        vm.label("_gc_is_heap_ptr");
        vm.prologue(0, []);

        // payload = value & 0x0000FFFFFFFFFFFF
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V2, VReg.A0, VReg.V1); // V2 = payload
        // tag = value >> 48
        vm.shrImm(VReg.V3, VReg.A0, 48); // V3 = 高 16 位

        // tag==0（裸指针）→ tagok
        vm.cmpImm(VReg.V3, 0);
        vm.jeq("_gchp_tagok");
        // (tag & 0xfffc)==0x7ffc 覆盖 0x7ffc..0x7fff（串/对象/数组/函数）
        vm.andImm(VReg.V4, VReg.V3, 0xfffc);
        vm.cmpImm(VReg.V4, 0x7ffc);
        vm.jeq("_gchp_tagok");
        // 其它 tag（含 0x7ff8..0x7ffb 的 int/bool/null/undef、普通 double）→ 非指针
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);

        vm.label("_gchp_tagok");
        // 非 8 对齐 → floor8(字节粒度内部指针,mark_one 解析真容器;曾直接拒 →
        // 只持字节游标的容器漏标)
        vm.movImm(VReg.V4, -8);
        vm.and(VReg.V2, VReg.V2, VReg.V4);
        // 范围检查
        vm.lea(VReg.V5, "_heap_meta");
        vm.load(VReg.V6, VReg.V5, META_HEAP_BASE); // heap_base
        vm.load(VReg.V7, VReg.V5, META_HEAP_USED); // used
        vm.addImm(VReg.V1, VReg.V6, HEADER_SIZE);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_gchp_no"); // payload < heap_base+16
        vm.add(VReg.V1, VReg.V6, VReg.V7); // heap_base+used
        vm.cmp(VReg.V2, VReg.V1);
        vm.jgt("_gchp_no"); // payload > heap_end
        vm.mov(VReg.RET, VReg.V2);
        vm.epilogue([], 0);

        vm.label("_gchp_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);
    }

    // _gc_block_footprint(A0=header_flags_value) -> RET = 整块字节数（含头）
    // 从 size 字段唯一决定：size<=512 走小对象（class 复算），否则大对象。
    // 与 _alloc 的分配路径完全一致，保证 sweep 线性走块精确对齐。
    generateGcBlockFootprint() {
        const vm = this.vm;
        vm.label("_gc_block_footprint");
        vm.prologue(0, [VReg.S0]);
        vm.shrImm(VReg.S0, VReg.A0, SIZE_SHIFT); // S0 = size（用户字节）
        // 哨兵(class=63,span gap/尾余填充块):footprint = size+16 精确,不走 class 圆整
        vm.shrImm(VReg.V0, VReg.A0, CLASS_SHIFT);
        vm.andImm(VReg.V0, VReg.V0, 0x3ff);
        vm.cmpImm(VReg.V0, SPAN_SENTINEL_CLASS);
        vm.jeq("_gbf_large"); // 与大对象同式:size+16
        vm.movImm(VReg.V0, MAX_SMALL_SIZE);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jgt("_gbf_large");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_get_size_class");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_get_class_size");
        vm.addImm(VReg.RET, VReg.RET, HEADER_SIZE);
        vm.epilogue([VReg.S0], 0);
        vm.label("_gbf_large");
        vm.addImm(VReg.RET, VReg.S0, HEADER_SIZE);
        vm.epilogue([VReg.S0], 0);
    }

    // _gc_mark_one(A0=用户指针)：在标记位图置位并压入标记栈（仅当此前未标记）。
    // A0 必须已通过 _gc_is_heap_ptr（是合法用户指针）。0 直接返回。
    // mark 位存于独立位图（bit 索引 = (block-heap_base)/8），绝不写对象头，
    // 因此保守误判指针最多点亮一个从不被读的位，不会腐蚀任何活对象。
    generateGcMarkOne() {
        const vm = this.vm;
        vm.label("_gc_mark_one");
        vm.prologue(0, [VReg.S0]);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcm1_done");
        vm.mov(VReg.S0, VReg.A0); // S0 = user ptr
        // block = ptr - 16；off = block - heap_base；bitIdx = off>>3
        vm.subImm(VReg.V0, VReg.S0, HEADER_SIZE); // V0 = block
        vm.lea(VReg.V1, "_heap_meta");
        vm.load(VReg.V2, VReg.V1, META_HEAP_BASE);
        vm.sub(VReg.V0, VReg.V0, VReg.V2); // V0 = off
        vm.shrImm(VReg.V0, VReg.V0, 3); // V0 = bitIdx

        // ---- 内部指针解析(2026-07-10 布局运气毁堆根修)----
        // 候选块起始(ptr-16)必须在 startmap 有起始 bit;否则 ptr 是内部指针
        // (栈上属性/内容游标等),向后扫 startmap 找真容器起始。不解析则标错位、
        // 真容器被 sweep 回收。V2=heap_base、V5=startmap 基址 全程保活。
        vm.shrImm(VReg.V3, VReg.V0, 6);
        vm.shlImm(VReg.V3, VReg.V3, 3); // V3 = word 字节偏移(回扫游标)
        vm.andImm(VReg.V4, VReg.V0, 63); // V4 = bit-in-word
        vm.lea(VReg.V5, "_gc_startmap_base");
        vm.load(VReg.V5, VReg.V5, 0); // V5 = startmap base
        vm.add(VReg.V6, VReg.V5, VReg.V3);
        vm.load(VReg.V6, VReg.V6, 0); // V6 = word
        vm.movImm(VReg.V7, 1);
        vm.shl(VReg.V7, VReg.V7, VReg.V4);
        vm.and(VReg.V1, VReg.V6, VReg.V7);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_gcm1_start_ok"); // 恰是块起始 → 快路

        // ---- span 页 O(1) 解析(#20 S1):pagemap[页]∈1..18 → 格网整除得块起始 ----
        // 保活:V0=候选 bitIdx、V2=heap_base、V5=startmap 基址、S0=user ptr。
        vm.sub(VReg.V1, VReg.S0, VReg.V2);
        vm.shrImm(VReg.V1, VReg.V1, SPAN_SHIFT); // 页号
        vm.lea(VReg.V4, "_gc_pagemap_base");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.add(VReg.V4, VReg.V4, VReg.V1);
        vm.loadByte(VReg.V4, VReg.V4, 0); // class+1
        vm.cmpImm(VReg.V4, 0);
        vm.jeq("_gcm1_backprep");
        vm.cmpImm(VReg.V4, NUM_SIZE_CLASSES);
        vm.jgt("_gcm1_backprep");
        vm.shlImm(VReg.V1, VReg.V1, SPAN_SHIFT);
        vm.add(VReg.V1, VReg.V1, VReg.V2); // span_base
        vm.subImm(VReg.V4, VReg.V4, 1);
        vm.shlImm(VReg.V4, VReg.V4, 3);
        vm.lea(VReg.V6, "_gc_c2s");
        vm.add(VReg.V6, VReg.V6, VReg.V4);
        vm.load(VReg.V6, VReg.V6, 0); // classSize
        vm.addImm(VReg.V6, VReg.V6, HEADER_SIZE); // stride
        vm.sub(VReg.V7, VReg.S0, VReg.V1);
        vm.div(VReg.V7, VReg.V7, VReg.V6);
        vm.mul(VReg.V7, VReg.V7, VReg.V6);
        vm.add(VReg.V1, VReg.V1, VReg.V7); // 真块起始
        vm.sub(VReg.V0, VReg.V1, VReg.V2);
        vm.shrImm(VReg.V0, VReg.V0, 3); // V0 = 真容器 bitIdx
        vm.addImm(VReg.V1, VReg.V1, HEADER_SIZE);
        vm.mov(VReg.S0, VReg.V1); // S0 = 真容器用户区指针
        vm.jmp("_gcm1_start_ok");

        // ---- startmap 回扫慢路(大对象/非 span 区)----
        vm.label("_gcm1_backprep");
        // pagemap 段毁了 V3/V4/V6/V7,从 V0/V5 重建
        vm.shrImm(VReg.V3, VReg.V0, 6);
        vm.shlImm(VReg.V3, VReg.V3, 3); // word 字节偏移
        vm.andImm(VReg.V4, VReg.V0, 63);
        vm.add(VReg.V6, VReg.V5, VReg.V3);
        vm.load(VReg.V6, VReg.V6, 0); // word
        vm.movImm(VReg.V7, 1);
        vm.shl(VReg.V7, VReg.V7, VReg.V4);
        // 慢路:掩掉高于候选 bit 的位(mask=(V7<<1)-1;bit=63 时溢出得全 1)
        vm.shlImm(VReg.V7, VReg.V7, 1);
        vm.subImm(VReg.V7, VReg.V7, 1);
        vm.and(VReg.V6, VReg.V6, VReg.V7);
        vm.movImm64(VReg.V1, 65536n); // 回扫上限 64K word(覆盖 32MB 跨度的大块)
        vm.label("_gcm1_backscan");
        vm.cmpImm(VReg.V6, 0);
        vm.jne("_gcm1_findtop");
        vm.subImm(VReg.V3, VReg.V3, 8);
        vm.cmpImm(VReg.V3, 0);
        vm.jlt("_gcm1_done"); // 扫过位图前沿 → 放弃(与旧行为同)
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_gcm1_done"); // 上限用尽 → 放弃
        vm.add(VReg.V6, VReg.V5, VReg.V3);
        vm.load(VReg.V6, VReg.V6, 0);
        vm.jmp("_gcm1_backscan");
        vm.label("_gcm1_findtop");
        // 非零 word:找最高位(即最近的块起始)
        vm.movImm(VReg.V4, 63);
        vm.movImm64(VReg.V7, 0x8000000000000000n);
        vm.label("_gcm1_toploop");
        vm.and(VReg.V1, VReg.V6, VReg.V7);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_gcm1_topfound");
        vm.shrImm(VReg.V7, VReg.V7, 1);
        vm.subImm(VReg.V4, VReg.V4, 1);
        vm.jmp("_gcm1_toploop"); // word 非零,必然终止
        vm.label("_gcm1_topfound");
        vm.shlImm(VReg.V0, VReg.V3, 3); // word 字节偏移*8 = word 首 bitIdx
        vm.add(VReg.V0, VReg.V0, VReg.V4); // V0 = 真容器 bitIdx
        // S0 = 真容器用户区指针(drain 由此扫整块)
        vm.shlImm(VReg.V1, VReg.V0, 3);
        vm.add(VReg.V1, VReg.V1, VReg.V2);
        vm.addImm(VReg.V1, VReg.V1, HEADER_SIZE);
        vm.mov(VReg.S0, VReg.V1);
        vm.label("_gcm1_start_ok");

        vm.shrImm(VReg.V1, VReg.V0, 6); // V1 = word index
        vm.shlImm(VReg.V1, VReg.V1, 3); // V1 = word byte offset
        vm.andImm(VReg.V2, VReg.V0, 63); // V2 = bit-in-word
        vm.movImm(VReg.V3, 1);
        vm.shl(VReg.V3, VReg.V3, VReg.V2); // V3 = mask
        vm.lea(VReg.V4, "_gc_bitmap_base");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.add(VReg.V4, VReg.V4, VReg.V1); // V4 = word addr
        vm.load(VReg.V5, VReg.V4, 0); // V5 = word
        vm.and(VReg.V6, VReg.V5, VReg.V3);
        vm.cmpImm(VReg.V6, 0);
        vm.jne("_gcm1_done"); // 已标记，防环
        vm.or(VReg.V5, VReg.V5, VReg.V3);
        vm.store(VReg.V4, 0, VReg.V5); // 置位
        // push S0
        vm.lea(VReg.V3, "_gc_mstack_top");
        vm.load(VReg.V4, VReg.V3, 0); // V4 = top
        vm.lea(VReg.V5, "_gc_mstack_cap");
        vm.load(VReg.V6, VReg.V5, 0); // V6 = cap
        vm.cmp(VReg.V4, VReg.V6);
        vm.jge("_gcm1_overflow");
        vm.lea(VReg.V5, "_gc_mstack_base");
        vm.load(VReg.V6, VReg.V5, 0); // V6 = base
        vm.shl(VReg.V7, VReg.V4, 3); // top*8
        vm.add(VReg.V6, VReg.V6, VReg.V7);
        vm.store(VReg.V6, 0, VReg.S0);
        vm.addImm(VReg.V4, VReg.V4, 1);
        vm.store(VReg.V3, 0, VReg.V4);
        vm.jmp("_gcm1_done");
        vm.label("_gcm1_overflow");
        // 栈满：对象已标记但未入队；置溢出标志，collect 后线性 rescan 补扫
        vm.lea(VReg.V3, "_gc_overflow");
        vm.movImm(VReg.V4, 1);
        vm.store(VReg.V3, 0, VReg.V4);
        vm.label("_gcm1_done");
        vm.epilogue([VReg.S0], 0);
    }

    // _gc_is_marked(A0=block 头地址) -> RET = 非0 表示已标记。读标记位图，不碰对象头。
    generateGcIsMarked() {
        const vm = this.vm;
        vm.label("_gc_is_marked");
        vm.prologue(0, []);
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_HEAP_BASE);
        vm.sub(VReg.V0, VReg.A0, VReg.V1); // off = block - heap_base
        vm.shrImm(VReg.V0, VReg.V0, 3); // bitIdx
        vm.shrImm(VReg.V1, VReg.V0, 6); // word idx
        vm.shlImm(VReg.V1, VReg.V1, 3); // word byte offset
        vm.andImm(VReg.V2, VReg.V0, 63); // bit-in-word
        vm.movImm(VReg.V3, 1);
        vm.shl(VReg.V3, VReg.V3, VReg.V2); // mask
        vm.lea(VReg.V4, "_gc_bitmap_base");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.add(VReg.V4, VReg.V4, VReg.V1);
        vm.load(VReg.V5, VReg.V4, 0);
        vm.and(VReg.RET, VReg.V5, VReg.V3);
        vm.epilogue([], 0);
    }

    // _gc_drain()：处理标记栈直到空。弹出对象，保守扫描其用户区每 8 字节，
    // 对每个"看起来像堆指针"的值调用 _gc_mark_one。
    generateGcDrain() {
        const vm = this.vm;
        vm.label("_gc_drain");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        // 循环外提堆边界(S4=heap_base+16 下界,S5=heap_end 上界)。
        // 不变量:标记阶段绝不分配(见 GC_MARK_STACK 注释),边界全程不变。
        // 用途:扫描内循环的内联快速判定——此前每个存活字都 call _gc_is_heap_ptr,
        // 540MB 存活 = 6700 万字 × 2 call ≈ 单次 full GC 8.5s 的主项。
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.S4, VReg.V0, META_HEAP_BASE);
        vm.load(VReg.S5, VReg.V0, META_HEAP_USED);
        vm.add(VReg.S5, VReg.S4, VReg.S5); // S5 = heap_end
        vm.addImm(VReg.S4, VReg.S4, HEADER_SIZE); // S4 = heap_base+16

        vm.label("_gcd_loop");
        vm.lea(VReg.V0, "_gc_mstack_top");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_gcd_done");
        // pop
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1); // top--
        vm.lea(VReg.V2, "_gc_mstack_base");
        vm.load(VReg.V3, VReg.V2, 0);
        vm.shl(VReg.V4, VReg.V1, 3);
        vm.add(VReg.V3, VReg.V3, VReg.V4);
        vm.load(VReg.S0, VReg.V3, 0); // S0 = user ptr
        // 扫描整块用户区 [user, block+footprint)（用 footprint 而非记录 size，
        // 覆盖到 size class 对齐的全部字节，防某类型指针字段落在记录 size 之外被漏标）
        vm.subImm(VReg.V0, VReg.S0, HEADER_SIZE); // block
        vm.load(VReg.A0, VReg.V0, HDR_FLAGS_SIZE);
        vm.call("_gc_block_footprint"); // RET = footprint（含头）
        vm.subImm(VReg.V2, VReg.RET, HEADER_SIZE); // 用户区字节
        // scan_end = min(user+userbytes, heap_end)
        vm.add(VReg.S3, VReg.S0, VReg.V2); // 暂定 scan_end
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_HEAP_BASE);
        vm.load(VReg.V2, VReg.V0, META_HEAP_USED);
        vm.add(VReg.V1, VReg.V1, VReg.V2); // cap = heap_end
        vm.cmp(VReg.S3, VReg.V1);
        vm.jle("_gcd_scan_setup");
        vm.mov(VReg.S3, VReg.V1); // clamp
        vm.label("_gcd_scan_setup");
        vm.mov(VReg.S2, VReg.S0); // cur = user ptr

        vm.label("_gcd_scan_loop");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_gcd_loop");
        vm.load(VReg.A0, VReg.S2, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcd_next");
        // 内联 _gc_is_heap_ptr 等价判定(快速拒绝占绝大多数,免 call):
        // tag==0(裸)或 (tag&0xfffc)==0x7ffc(串/对象/数组/函数)才可能是指针
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_gcd_chk");
        vm.andImm(VReg.V0, VReg.V0, 0xfffc);
        vm.cmpImm(VReg.V0, 0x7ffc);
        vm.jne("_gcd_next"); // int/double/bool/undef 等 → 拒
        vm.label("_gcd_chk");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V1, VReg.A0, VReg.V1); // payload
        vm.movImm(VReg.V0, -8);
        vm.and(VReg.V1, VReg.V1, VReg.V0); // floor8(字节游标交给 mark_one 解析)
        vm.cmp(VReg.V1, VReg.S4);
        vm.jlt("_gcd_next"); // < heap_base+16 → 拒
        vm.cmp(VReg.V1, VReg.S5);
        vm.jgt("_gcd_next"); // > heap_end → 拒
        vm.mov(VReg.A0, VReg.V1);
        vm.call("_gc_mark_one");
        vm.label("_gcd_next");
        vm.addImm(VReg.S2, VReg.S2, 8);
        vm.jmp("_gcd_scan_loop");

        vm.label("_gcd_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // _gc_mark_roots()：标记所有根。
    //   1) native 栈 [当前 SP, _stack_base)
    //   2) 数据段 [_data_start, _data_gc_end)，跳过 [_heap_meta, _heap_meta_end)
    generateGcMarkRoots() {
        const vm = this.vm;
        vm.label("_gc_mark_roots");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        // ---- 栈扫描 ----
        vm.mov(VReg.S0, VReg.SP); // S0 = 当前 SP（低地址）
        vm.lea(VReg.V0, "_stack_base");
        vm.load(VReg.S1, VReg.V0, 0); // S1 = 栈底（高地址）
        vm.label("_gcr_sloop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcr_sdone");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcr_snext");
        vm.call("_gc_is_heap_ptr");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gcr_snext");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_gc_mark_one");
        vm.label("_gcr_snext");
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gcr_sloop");
        vm.label("_gcr_sdone");

        // ---- 数据段扫描 ----
        vm.lea(VReg.S0, "_data_start"); // 数据段基址（偏移 0）
        vm.lea(VReg.S1, "_data_gc_end"); // 数据段 qword 区终点（strings 之前）
        vm.label("_gcr_dloop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcr_ddone");
        // 跳过 [_heap_meta, _heap_meta_end)
        vm.lea(VReg.V0, "_heap_meta");
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_gcr_dscan");
        vm.lea(VReg.V1, "_heap_meta_end");
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_gcr_dscan");
        vm.mov(VReg.S0, VReg.V1); // 落在跳过区 → 跳到区尾
        vm.jmp("_gcr_dloop");
        vm.label("_gcr_dscan");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcr_dnext");
        vm.call("_gc_is_heap_ptr");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gcr_dnext");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_gc_mark_one");
        vm.label("_gcr_dnext");
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gcr_dloop");
        vm.label("_gcr_ddone");

        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [M5] _gc_scan_stack_range(A0=lo, A1=hi):保守扫描 [lo, hi) 每个 qword,heap 指针则 mark。
    // 与 _gc_mark_roots 的栈扫描内循环同构。仅 linux-arm64 发射(多 M STW 扩展根扫描用)。
    generateGcScanStackRange() {
        const vm = this.vm;
        if (!(vm.platform === "linux" && vm.arch === "arm64")) return;
        vm.label("_gc_scan_stack_range");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // lo(低地址=当前 SP)
        vm.mov(VReg.S1, VReg.A1); // hi(高地址=栈顶)
        vm.label("_gcsr_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcsr_done");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcsr_next");
        vm.call("_gc_is_heap_ptr");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gcsr_next");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_gc_mark_one");
        vm.label("_gcsr_next");
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gcsr_loop");
        vm.label("_gcsr_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [M5/M6] _gc_scan_other_ms():STW 期间扫描"非协调者"M 的执行栈根(§4-M5 剩余② 扩展根扫描)。
    // **N>2 一般化**:遍历 _p_array 全部 P_MAX 份 P,跳过①协调者自身(= _m_current_p,其主栈经
    // _gc_mark_roots 的 [SP, _stack_base) 扫)②未 park 者(saved_sp==0 —— 未起跑或已 resume,
    // `_safepoint_poll` resume 时清 0)。对每个已 park 的他人 M 扫 [saved_sp, stack_hi):g0 停点 =
    // 该 M 线程栈区间;协程栈停点(refill)= 运行中协程栈区间(park 时按 scheduler_current 现算,
    // §1.4 运行中 G 栈)。S0=遍历指针、S1=尾界(均跨 _gc_scan_stack_range 调用存活)。仅 linux-arm64。
    generateGcScanOtherMs() {
        const vm = this.vm;
        if (!(vm.platform === "linux" && vm.arch === "arm64")) return;
        vm.label("_gc_scan_other_ms");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.lea(VReg.S0, "_p_array");         // S0 = &_p_array[0]
        vm.lea(VReg.S1, "_p_array");
        vm.movImm(VReg.V0, P_SIZE * P_MAX);
        vm.add(VReg.S1, VReg.S1, VReg.V0);   // S1 = &_p_array[P_MAX](尾界)
        vm.label("_gcsom_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcsom_done");
        // 跳过协调者自身 P
        vm.lea(VReg.V0, "_m_current_p");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jeq("_gcsom_next");
        // saved_sp==0 → 未 park(未起跑/已 resume),无栈可扫
        vm.load(VReg.A0, VReg.S0, P_SAVED_SP);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcsom_next");
        vm.load(VReg.A1, VReg.S0, P_STACK_HI);
        vm.cmpImm(VReg.A1, 0);
        vm.jeq("_gcsom_next");
        vm.call("_gc_scan_stack_range");     // 扫 [saved_sp, stack_hi)
        vm.label("_gcsom_next");
        vm.movImm(VReg.V0, P_SIZE);
        vm.add(VReg.S0, VReg.S0, VReg.V0);
        vm.jmp("_gcsom_loop");
        vm.label("_gcsom_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _gc_rescan_overflow()：标记栈溢出的安全网。线性走堆，对每个已标记块，
    // 重新扫描其用户区，对未标记子对象调用 _gc_mark_one（重新入队）。
    // 由 _gc_collect 在溢出后循环调用+drain，直至不再溢出。极少触发。
    generateGcRescanOverflow() {
        const vm = this.vm;
        vm.label("_gc_rescan_overflow");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.S0, VReg.V0, META_HEAP_BASE); // S0 = cur block header
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.add(VReg.S1, VReg.S0, VReg.V1); // S1 = heap_end

        vm.label("_gcro_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcro_done");
        vm.load(VReg.V0, VReg.S0, HDR_FLAGS_SIZE); // header
        // footprint -> S3
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_gc_block_footprint");
        vm.mov(VReg.S3, VReg.RET);
        // 是否已标记（查位图）
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_is_marked");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gcro_advance"); // 未标记 → 跳过（将被 sweep 回收）
        // 已标记：扫描子对象。S2=cur user 指针，S4=scan_end（都用 callee-saved 跨 call 保活）
        vm.load(VReg.V0, VReg.S0, HDR_FLAGS_SIZE);
        vm.shrImm(VReg.V1, VReg.V0, SIZE_SHIFT); // size
        vm.addImm(VReg.S2, VReg.S0, HEADER_SIZE); // cur = user ptr
        vm.add(VReg.S4, VReg.S2, VReg.V1); // scan_end tentative
        vm.cmp(VReg.S4, VReg.S1); // clamp 到 heap_end
        vm.jle("_gcro_scan");
        vm.mov(VReg.S4, VReg.S1);
        vm.label("_gcro_scan");
        vm.cmp(VReg.S2, VReg.S4);
        vm.jge("_gcro_advance");
        vm.load(VReg.A0, VReg.S2, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gcro_scan_next");
        vm.call("_gc_is_heap_ptr");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gcro_scan_next");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_gc_mark_one");
        vm.label("_gcro_scan_next");
        vm.addImm(VReg.S2, VReg.S2, 8);
        vm.jmp("_gcro_scan");
        vm.label("_gcro_advance");
        vm.add(VReg.S0, VReg.S0, VReg.S3);
        vm.jmp("_gcro_loop");
        vm.label("_gcro_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // _gc_sweep()：线性走堆。未标记块 → 按大小挂回 free_lists / large_free；
    // 已标记块 → 累计 live_bytes。
    // 关键：sweep 开始前先清空所有 free-list。否则上轮 GC 释放、尚未复用的空闲块，
    // 本轮线性走堆时仍未标记，会被再次挂入 free-list → 同一块在链表里出现两次
    // （或 HDR_NEXT 被覆写成链表指针后又当作 length 等）→ 链表成环/garbage → 崩。
    // 每轮从零重建 free-list：每个未标记块（无论此前是否已空闲）只被加入恰好一次。
    generateGcSweep() {
        const vm = this.vm;
        vm.label("_gc_sweep");
        // 局部 16B:[SP+0]=heap_base(位图偏移计算用);S4=bitmap_base(循环外提)。
        // 内循环零 call(此前每块 3 call:is_marked/get_size_class/get_class_size,
        // 2GB 堆 ~2200 万块 → sweep 是 full GC 5s 中的另一主项):
        // is_marked 内联位图查询;class/footprint 用数据段表 _gc_s2c/_gc_c2s 查表。
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        // live_bytes = 0
        vm.lea(VReg.V0, "_gc_live_bytes");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);

        // 清空 free_lists[0..17] 与 large_free（从零重建，防跨代重复挂入）
        vm.lea(VReg.V0, "_heap_meta");
        vm.movImm(VReg.V1, 0);
        for (let i = 0; i < NUM_SIZE_CLASSES; i++) {
            vm.store(VReg.V0, META_FREE_LISTS + i * 8, VReg.V1);
        }
        vm.store(VReg.V0, META_LARGE_FREE, VReg.V1);

        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.S0, VReg.V0, META_HEAP_BASE); // S0 = cur
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.add(VReg.S1, VReg.S0, VReg.V1); // S1 = heap_end
        vm.store(VReg.SP, 0, VReg.S0); // [SP+0] = heap_base
        vm.lea(VReg.S4, "_gc_bitmap_base");
        vm.load(VReg.S4, VReg.S4, 0); // S4 = bitmap_base

        vm.label("_gcs_loop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gcs_done");
        vm.load(VReg.V0, VReg.S0, HDR_FLAGS_SIZE); // header
        vm.shrImm(VReg.S2, VReg.V0, SIZE_SHIFT); // S2 = size
        // 计算 footprint(S5) 与 free-list 归属(S3: class / -1 大对象 / -2 哨兵)——表驱动,零 call
        // 哨兵(class=63,span gap/尾余):footprint=size+16 精确,永不挂链
        vm.shrImm(VReg.V1, VReg.V0, CLASS_SHIFT);
        vm.andImm(VReg.V1, VReg.V1, 0x3ff);
        vm.cmpImm(VReg.V1, SPAN_SENTINEL_CLASS);
        vm.jne("_gcs_notsent");
        vm.addImm(VReg.S5, VReg.S2, HEADER_SIZE);
        vm.movImm(VReg.S3, -2);
        vm.jmp("_gcs_check");
        vm.label("_gcs_notsent");
        vm.movImm(VReg.V1, MAX_SMALL_SIZE);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jgt("_gcs_large_calc");
        vm.shrImm(VReg.V0, VReg.S2, 3); // size/8 ∈ [0,64]
        vm.lea(VReg.V1, "_gc_s2c");
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.loadByte(VReg.S3, VReg.V1, 0); // S3 = class
        vm.lea(VReg.V1, "_gc_c2s");
        vm.shl(VReg.V0, VReg.S3, 3);
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V1, 0); // class size
        vm.addImm(VReg.S5, VReg.V0, HEADER_SIZE); // footprint
        vm.jmp("_gcs_check");
        vm.label("_gcs_large_calc");
        vm.addImm(VReg.S5, VReg.S2, HEADER_SIZE); // footprint
        vm.movImm(VReg.S3, -1); // 大对象

        vm.label("_gcs_check");
        // 防御：footprint 越过 heap_end 说明块边界失步（某处 size 头被破坏）。
        // 立即安全收尾——已处理的块都基于此前正确边界，不再往 free-list 塞垃圾块。
        vm.add(VReg.V0, VReg.S0, VReg.S5);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jgt("_gcs_done");

        // is_marked 内联(位图 1 bit/8B 堆):bitIdx=(cur-heap_base)>>3
        vm.load(VReg.V1, VReg.SP, 0); // heap_base
        vm.sub(VReg.V0, VReg.S0, VReg.V1);
        vm.shrImm(VReg.V0, VReg.V0, 3); // bitIdx
        vm.shrImm(VReg.V1, VReg.V0, 6); // word idx
        vm.shlImm(VReg.V1, VReg.V1, 3);
        vm.andImm(VReg.V2, VReg.V0, 63);
        vm.movImm(VReg.V3, 1);
        vm.shl(VReg.V3, VReg.V3, VReg.V2); // bit mask
        vm.add(VReg.V1, VReg.S4, VReg.V1);
        vm.load(VReg.V1, VReg.V1, 0);
        vm.and(VReg.V1, VReg.V1, VReg.V3);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_gcs_marked");
        // ---- 未标记：回收 ----
        // [GC_POISON] 判别诊断:死块不挂 free-list,用户区毒填 0xDEAD..(保留头)。
        // 若 GC 后崩在毒值上 → 证明「活对象被漏标回收」,崩点直接点名受害块。
        if (process.env.GC_POISON) {
            vm.addImm(VReg.V0, VReg.S0, HEADER_SIZE);
            vm.add(VReg.V1, VReg.S0, VReg.S5); // end = block+footprint
            vm.movImm64(VReg.V2, 0xdeaddeaddeaddeadn);
            vm.label("_gcs_poison_loop");
            vm.cmp(VReg.V0, VReg.V1);
            vm.jge("_gcs_advance");
            vm.store(VReg.V0, 0, VReg.V2);
            vm.addImm(VReg.V0, VReg.V0, 8);
            vm.jmp("_gcs_poison_loop");
        }
        vm.cmpImm(VReg.S3, -2);
        vm.jeq("_gcs_advance"); // 哨兵:不挂链
        vm.cmpImm(VReg.S3, -1);
        vm.jeq("_gcs_free_large");
        // 小对象：挂 free_lists[S3]
        vm.lea(VReg.V0, "_heap_meta");
        vm.shl(VReg.V1, VReg.S3, 3);
        vm.addImm(VReg.V1, VReg.V1, META_FREE_LISTS);
        vm.add(VReg.V1, VReg.V0, VReg.V1); // &free_lists[class]
        vm.load(VReg.V2, VReg.V1, 0); // old head
        vm.store(VReg.S0, HDR_NEXT, VReg.V2);
        vm.store(VReg.V1, 0, VReg.S0);
        vm.jmp("_gcs_advance");
        vm.label("_gcs_free_large");
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V2, VReg.V0, META_LARGE_FREE);
        vm.store(VReg.S0, HDR_NEXT, VReg.V2);
        vm.store(VReg.V0, META_LARGE_FREE, VReg.S0);
        vm.jmp("_gcs_advance");
        // ---- 已标记：累计 live（位图下次 GC 前统一清零，无需逐块清 mark）----
        vm.label("_gcs_marked");
        vm.lea(VReg.V1, "_gc_live_bytes");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.add(VReg.V2, VReg.V2, VReg.S5);
        vm.store(VReg.V1, 0, VReg.V2);

        vm.label("_gcs_advance");
        vm.add(VReg.S0, VReg.S0, VReg.S5);
        vm.jmp("_gcs_loop");
        vm.label("_gcs_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 16);
    }

    // ==================== GC_DIAG 漏标诊断（仅 GC_DIAG env 下生成/调用）====================
    // 目标：mark+drain 完、sweep 前，找出「活引用者(已标记块或根) → 未标记块」的边。
    //   - 若引用者是已标记块 → 遍历漏（drain 没扫到该字段）。
    //   - 若引用者是根(栈/数据段) → 根漏。
    //   - 若三类扫描都为空但仍崩 → 引用者在未扫描区（独立栈/寄存器/被破坏 size 头之外）。
    // 全程只读，不分配、不改位图。输出经 write(2) 直达 stderr（无缓冲，崩溃不丢）。

    // _gc_diag_hex(A0=value)：把 A0 的 16 位十六进制写到 fd2（无换行）。
    generateGcDiagHex() {
        const vm = this.vm;
        vm.label("_gc_diag_hex");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // S0 = 剩余值
        vm.movImm(VReg.S1, 15); // pos（从右往左填）
        vm.label("_gdh_loop");
        vm.andImm(VReg.V2, VReg.S0, 0xf); // nibble
        vm.cmpImm(VReg.V2, 10);
        vm.jlt("_gdh_dig");
        vm.addImm(VReg.V2, VReg.V2, 0x27); // 'a'-'0'-10
        vm.label("_gdh_dig");
        vm.addImm(VReg.V2, VReg.V2, 0x30); // + '0'
        vm.lea(VReg.V3, "_gc_diag_buf");
        vm.add(VReg.V3, VReg.V3, VReg.S1);
        vm.storeByte(VReg.V3, 0, VReg.V2);
        vm.shrImm(VReg.S0, VReg.S0, 4);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_gdh_loop");
        // write(2, buf, 16)
        vm.movImm(VReg.A0, 2);
        vm.lea(VReg.A1, "_gc_diag_buf");
        vm.movImm(VReg.A2, 16);
        vm.syscall(this.vm.platform === "linux" ? 64 : 4);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _gc_diag_line(A0=referrer_addr, A1=target_user)：打印一条边
    //   "<referrer> -> <target> hdr=<target_block_header>\n"
    generateGcDiagLine() {
        const vm = this.vm;
        const wr = this.vm.platform === "linux" ? 64 : 4;
        const puts = (s) => {
            vm.movImm(VReg.A0, 2);
            vm.lea(VReg.A1, this.vm.asm.addString(s));
            vm.movImm(VReg.A2, s.length);
            vm.syscall(wr);
        };
        vm.label("_gc_diag_line");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // referrer
        vm.mov(VReg.S1, VReg.A1); // target user
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_diag_hex");
        puts(" -> ");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_gc_diag_hex");
        puts(" hdr=");
        vm.subImm(VReg.V0, VReg.S1, HEADER_SIZE);
        vm.load(VReg.A0, VReg.V0, HDR_FLAGS_SIZE);
        vm.call("_gc_diag_hex");
        puts("\n");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _gc_diag_set_start(A0=block 头地址)：在块起始位图置位。
    generateGcDiagStartHelpers() {
        const vm = this.vm;
        // set
        vm.label("_gc_diag_set_start");
        vm.prologue(0, []);
        vm.lea(VReg.V1, "_heap_meta");
        vm.load(VReg.V2, VReg.V1, META_HEAP_BASE);
        vm.sub(VReg.V0, VReg.A0, VReg.V2); // off
        vm.shrImm(VReg.V0, VReg.V0, 3); // bitIdx
        vm.shrImm(VReg.V1, VReg.V0, 6); // word idx
        vm.shlImm(VReg.V1, VReg.V1, 3); // word byte offset
        vm.andImm(VReg.V2, VReg.V0, 63);
        vm.movImm(VReg.V3, 1);
        vm.shl(VReg.V3, VReg.V3, VReg.V2);
        vm.lea(VReg.V4, "_gc_diag_startmap");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.add(VReg.V4, VReg.V4, VReg.V1);
        vm.load(VReg.V5, VReg.V4, 0);
        vm.or(VReg.V5, VReg.V5, VReg.V3);
        vm.store(VReg.V4, 0, VReg.V5);
        vm.epilogue([], 0);
        // is_start -> RET nonzero if set
        vm.label("_gc_diag_is_start");
        vm.prologue(0, []);
        vm.lea(VReg.V1, "_heap_meta");
        vm.load(VReg.V2, VReg.V1, META_HEAP_BASE);
        vm.sub(VReg.V0, VReg.A0, VReg.V2);
        vm.shrImm(VReg.V0, VReg.V0, 3);
        vm.shrImm(VReg.V1, VReg.V0, 6);
        vm.shlImm(VReg.V1, VReg.V1, 3);
        vm.andImm(VReg.V2, VReg.V0, 63);
        vm.movImm(VReg.V3, 1);
        vm.shl(VReg.V3, VReg.V3, VReg.V2);
        vm.lea(VReg.V4, "_gc_diag_startmap");
        vm.load(VReg.V4, VReg.V4, 0);
        vm.add(VReg.V4, VReg.V4, VReg.V1);
        vm.load(VReg.V5, VReg.V4, 0);
        vm.and(VReg.RET, VReg.V5, VReg.V3);
        vm.epilogue([], 0);
    }

    // _gc_diag_resolve(A0=地址)->RET：最近的 <=A0 的块起始（向下最多 64KB），找不到=0。
    generateGcDiagResolve() {
        const vm = this.vm;
        vm.label("_gc_diag_resolve");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.movImm(VReg.V0, -8);
        vm.and(VReg.S0, VReg.A0, VReg.V0); // floor8
        vm.movImm(VReg.S1, 8192); // 8192*8=64KB 上限
        vm.label("_gdr_loop");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_diag_is_start");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_gdr_found");
        vm.subImm(VReg.S0, VReg.S0, 8);
        vm.subImm(VReg.S1, VReg.S1, 1);
        vm.cmpImm(VReg.S1, 0);
        vm.jge("_gdr_loop");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_gdr_found");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _gc_diag_check(A0=word 值, A1=存放该字的地址)：判定并按需打印一条可疑边。
    //   is_heap_ptr(word)=P；block=P-16。
    //     - 若 block 非块起始 → INTERIOR 指针（保守扫描 mark block=P-16 会标错块，真 R 漏标）。
    //     - 若是起始但未标记 → UNMARKED（活位置指向将被回收的块）。
    // 计数于 _gc_val_count；仅前 LIMIT 条实际打印。
    generateGcDiagCheck() {
        const vm = this.vm;
        const wr = this.vm.platform === "linux" ? 64 : 4;
        const LIMIT = 60;
        const puts = (s) => {
            vm.movImm(VReg.A0, 2);
            vm.lea(VReg.A1, this.vm.asm.addString(s));
            vm.movImm(VReg.A2, s.length);
            vm.syscall(wr);
        };
        vm.label("_gc_diag_check");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // loc
        vm.mov(VReg.S2, VReg.A2); // referrer block (0=root)
        vm.call("_gc_is_heap_ptr"); // A0=word
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gdchk_done");
        vm.mov(VReg.S0, VReg.RET); // P (target user)
        // budget?
        vm.lea(VReg.V0, "_gc_val_count");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, LIMIT);
        vm.jge("_gdchk_done");
        vm.subImm(VReg.A0, VReg.S0, HEADER_SIZE);
        vm.call("_gc_diag_is_start");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gdchk_interior");
        // exact start: marked?
        vm.subImm(VReg.A0, VReg.S0, HEADER_SIZE);
        vm.call("_gc_is_marked");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_gdchk_done"); // marked -> fine
        // exact-unmarked：活位置指向精确块起始但未标记 = 直接漏标
        puts("UNM rb=");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_gc_diag_hex");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_gc_diag_line");
        vm.jmp("_gdchk_inc");
        vm.label("_gdchk_interior");
        // 解析 P 的真实容器块，看它是否被标记
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_diag_resolve");
        vm.mov(VReg.S3, VReg.RET); // container block（0=未找到）
        // 容器已标记 → 内部指针无害（容器另有精确引用）→ 跳过不打印
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_gdchk_int_print");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_gc_is_marked");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_gdchk_done"); // 容器已标记 → 无害
        vm.label("_gdchk_int_print");
        // 内部指针且容器未标记 = 疑似漏标：容器 R 只被内部指针引用
        puts("INT ctr=");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_gc_diag_hex");
        puts(" chdr=");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_gdchk_int_nohdr");
        vm.load(VReg.A0, VReg.S3, HDR_FLAGS_SIZE);
        vm.jmp("_gdchk_int_hdrok");
        vm.label("_gdchk_int_nohdr");
        vm.movImm(VReg.A0, 0);
        vm.label("_gdchk_int_hdrok");
        vm.call("_gc_diag_hex");
        puts(" ");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_gc_diag_line");
        vm.label("_gdchk_inc");
        vm.lea(VReg.V0, "_gc_val_count");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_gdchk_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _gc_diag()：三遍扫描找 活→未标记 边。每类最多打印 LIMIT 条。
    generateGcDiag() {
        const vm = this.vm;
        const wr = this.vm.platform === "linux" ? 64 : 4;
        const LIMIT = 40;
        const puts = (s) => {
            vm.movImm(VReg.A0, 2);
            vm.lea(VReg.A1, this.vm.asm.addString(s));
            vm.movImm(VReg.A2, s.length);
            vm.syscall(wr);
        };
        vm.label("_gc_diag");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        // 头：== GC DIAG gc#=<count> ==\n
        puts("== GC DIAG gc#=");
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.A0, VReg.V0, META_GC_COUNT);
        vm.call("_gc_diag_hex");
        puts(" ==\n");
        // 计数清零
        vm.lea(VReg.V0, "_gc_val_count");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);

        // ---- 构建 块起始位图（懒 mmap，每次 GC 清空+重填）----
        vm.lea(VReg.V0, "_gc_diag_startmap");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_gd_havemap");
        vm.movImm(VReg.A0, 0);
        vm.movImm64(VReg.A1, BigInt(this.bitmapSize));
        vm.movImm(VReg.A2, 3);
        vm.movImm(VReg.A3, this.getMmapFlags());
        vm.movImm64(VReg.A4, 0xffffffffffffffffn);
        vm.movImm(VReg.A5, 0);
        vm.syscall(this.getSyscallNum("mmap"));
        vm.lea(VReg.V1, "_gc_diag_startmap");
        vm.store(VReg.V1, 0, VReg.RET);
        vm.label("_gd_havemap");
        // 清空 startmap [0, used/64 + 余量)
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.shrImm(VReg.V1, VReg.V1, 6);
        vm.addImm(VReg.V1, VReg.V1, 16);
        vm.lea(VReg.V2, "_gc_diag_startmap");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.movImm(VReg.V3, 0);
        vm.movImm(VReg.V6, 0);
        vm.label("_gd_smzero");
        vm.cmp(VReg.V3, VReg.V1);
        vm.jge("_gd_smzero_done");
        vm.add(VReg.V4, VReg.V2, VReg.V3);
        vm.store(VReg.V4, 0, VReg.V6);
        vm.addImm(VReg.V3, VReg.V3, 8);
        vm.jmp("_gd_smzero");
        vm.label("_gd_smzero_done");
        // 线性走块，置每个块起始 bit
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.S0, VReg.V0, META_HEAP_BASE);
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.add(VReg.S1, VReg.S0, VReg.V1);
        vm.label("_gd_bwalk");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gd_bwalk_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_diag_set_start");
        vm.load(VReg.S4, VReg.S0, HDR_FLAGS_SIZE); // 当前块头
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_gc_block_footprint");
        vm.mov(VReg.S5, VReg.RET); // footprint
        // 追踪：仅打印堆偏移 >= 0x1d000 的块（临近 stop 的最后几块）
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_HEAP_BASE);
        vm.sub(VReg.V2, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V3, 0x1d000n);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jlt("_gd_bwalk_notrace");
        puts("  blk=");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_diag_hex");
        puts(" hdr=");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_gc_diag_hex");
        puts(" fp=");
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_gc_diag_hex");
        puts("\n");
        vm.label("_gd_bwalk_notrace");
        vm.add(VReg.V0, VReg.S0, VReg.S5);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jgt("_gd_bwalk_done");
        vm.add(VReg.S0, VReg.S0, VReg.S5);
        vm.jmp("_gd_bwalk");
        vm.label("_gd_bwalk_done");
        // 报告 walk 是否走满（S0=停点，S1=heap_end）
        puts("walk_stop=");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_diag_hex");
        puts(" heap_end=");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_gc_diag_hex");
        puts(" base=");
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.A0, VReg.V0, META_HEAP_BASE);
        vm.call("_gc_diag_hex");
        puts("\n");

        // 原始 qword dump [stop-0x480, stop+0x80]，定位真实对象边界
        puts("-- raw dump --\n");
        vm.mov(VReg.S2, VReg.S0); // stop
        vm.subImm(VReg.S2, VReg.S2, 0x480); // lo（S0=stop 已被上面保留）
        vm.addImm(VReg.S3, VReg.S0, 0x80); // hi
        vm.label("_gd_rawdump");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_gd_rawdump_done");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_gc_diag_hex");
        puts(": ");
        vm.load(VReg.A0, VReg.S2, 0);
        vm.call("_gc_diag_hex");
        puts("\n");
        vm.addImm(VReg.S2, VReg.S2, 8);
        vm.jmp("_gd_rawdump");
        vm.label("_gd_rawdump_done");

        // ---- Pass 1: 已标记块 用户区（到 footprint）每字过 check ----
        puts("[MARK pass]\n");
        vm.lea(VReg.V0, "_gc_val_count");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.S0, VReg.V0, META_HEAP_BASE);
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.add(VReg.S1, VReg.S0, VReg.V1);
        vm.label("_gd_mloop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gd_mdone");
        vm.load(VReg.V0, VReg.S0, HDR_FLAGS_SIZE);
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_gc_block_footprint");
        vm.mov(VReg.S5, VReg.RET);
        vm.add(VReg.V0, VReg.S0, VReg.S5);
        vm.cmp(VReg.V0, VReg.S1);
        vm.jgt("_gd_mdone");
        vm.lea(VReg.V0, "_gc_val_count");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, LIMIT);
        vm.jge("_gd_mdone");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_is_marked");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_gd_madv");
        vm.addImm(VReg.S2, VReg.S0, HEADER_SIZE);
        vm.add(VReg.S3, VReg.S0, VReg.S5);
        vm.label("_gd_mscan");
        vm.cmp(VReg.S2, VReg.S3);
        vm.jge("_gd_madv");
        vm.load(VReg.A0, VReg.S2, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gd_mnext");
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A2, VReg.S0); // referrer block
        vm.call("_gc_diag_check");
        vm.label("_gd_mnext");
        vm.addImm(VReg.S2, VReg.S2, 8);
        vm.jmp("_gd_mscan");
        vm.label("_gd_madv");
        vm.add(VReg.S0, VReg.S0, VReg.S5);
        vm.jmp("_gd_mloop");
        vm.label("_gd_mdone");

        // ---- Pass 2: 栈根 ----
        puts("[STK pass]\n");
        vm.lea(VReg.V0, "_gc_val_count");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.mov(VReg.S0, VReg.SP);
        vm.lea(VReg.V0, "_stack_base");
        vm.load(VReg.S1, VReg.V0, 0);
        vm.label("_gd_sloop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gd_sdone");
        vm.lea(VReg.V0, "_gc_val_count");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, LIMIT);
        vm.jge("_gd_sdone");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gd_snext");
        vm.mov(VReg.A1, VReg.S0);
        vm.movImm(VReg.A2, 0);
        vm.call("_gc_diag_check");
        vm.label("_gd_snext");
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gd_sloop");
        vm.label("_gd_sdone");

        // ---- Pass 3: 数据段根（含 heap_meta 跳过）----
        puts("[DAT pass]\n");
        vm.lea(VReg.V0, "_gc_val_count");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.S0, "_data_start");
        vm.lea(VReg.S1, "_data_gc_end");
        vm.label("_gd_dloop");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jge("_gd_ddone");
        vm.lea(VReg.V0, "_heap_meta");
        vm.cmp(VReg.S0, VReg.V0);
        vm.jlt("_gd_dscan");
        vm.lea(VReg.V1, "_heap_meta_end");
        vm.cmp(VReg.S0, VReg.V1);
        vm.jge("_gd_dscan");
        vm.mov(VReg.S0, VReg.V1);
        vm.jmp("_gd_dloop");
        vm.label("_gd_dscan");
        vm.lea(VReg.V0, "_gc_val_count");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, LIMIT);
        vm.jge("_gd_ddone");
        vm.load(VReg.A0, VReg.S0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_gd_dnext");
        vm.mov(VReg.A1, VReg.S0);
        vm.movImm(VReg.A2, 0);
        vm.call("_gc_diag_check");
        vm.label("_gd_dnext");
        vm.addImm(VReg.S0, VReg.S0, 8);
        vm.jmp("_gd_dloop");
        vm.label("_gd_ddone");

        puts("== GC DIAG end ==\n");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // _gc_collect()：一次完整 GC。保存所有 callee-saved（当前根随之上栈），
    // 标记根 → drain（+溢出 rescan 循环）→ sweep → 更新计数/阈值。
    generateGcCollect() {
        const vm = this.vm;
        const isParallel = vm.platform === "linux" && vm.arch === "arm64";
        vm.label("_gc_collect");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        // gc_running = 1
        vm.lea(VReg.V0, "_heap_meta");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, META_GC_RUNNING, VReg.V1);
        // 标记栈 top=0, overflow=0
        vm.lea(VReg.V0, "_gc_mstack_top");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_overflow");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);

        // 清零标记位图覆盖 [0, heap_used] 的部分（used/64 + 余量 字节，8 字节步长）
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_HEAP_USED);
        vm.shrImm(VReg.V1, VReg.V1, 6); // 需清字节数 = used/64
        vm.addImm(VReg.V1, VReg.V1, 16); // 向上取整余量
        // 加固：clamp 到 GC_BITMAP_SIZE。正常自举 used 永不超 INITIAL_HEAP_SIZE，此 clamp 无副作用；
        // 但若上游 corruption 把 heap_used 顶过 28GB（bump/heap_grow），不 clamp 会写越位图 → SIGSEGV
        // 掩盖真正根因。宁可少清位图（残留位只会过标=保守安全），也不越界。
        vm.movImm64(VReg.V6, BigInt(this.bitmapSize));
        vm.cmp(VReg.V1, VReg.V6);
        vm.jle("_gcc_bmzero_noclamp");
        vm.mov(VReg.V1, VReg.V6);
        vm.label("_gcc_bmzero_noclamp");
        vm.lea(VReg.V2, "_gc_bitmap_base");
        vm.load(VReg.V2, VReg.V2, 0); // bitmap base
        vm.movImm(VReg.V3, 0); // 偏移
        vm.movImm(VReg.V5, 0); // 常量 0
        vm.label("_gcc_bmzero");
        vm.cmp(VReg.V3, VReg.V1);
        vm.jge("_gcc_bmzero_done");
        vm.add(VReg.V4, VReg.V2, VReg.V3);
        vm.store(VReg.V4, 0, VReg.V5);
        vm.addImm(VReg.V3, VReg.V3, 8);
        vm.jmp("_gcc_bmzero");
        vm.label("_gcc_bmzero_done");

        vm.call("_gc_mark_roots");
        // [M5] GOMAXPROCS>1:世界已由 STW 协调者停住(其它 M park 于安全点),扩展根扫描覆盖
        // 每个已 park 的 M 的执行栈 [saved_sp, stack_hi)。GOMAXPROCS=1 / macos 不发射此分支。
        if (isParallel) {
            vm.lea(VReg.V0, "_gomaxprocs");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmpImm(VReg.V0, 1);
            vm.jle("_gcc_skip_mt_roots");
            vm.call("_gc_scan_other_ms");
            vm.label("_gcc_skip_mt_roots");
        }

        vm.label("_gcc_drain");
        vm.call("_gc_drain");
        vm.lea(VReg.V0, "_gc_overflow");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_gcc_sweep");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1); // 清溢出
        vm.call("_gc_rescan_overflow");
        vm.jmp("_gcc_drain");

        vm.label("_gcc_sweep");
        if (process.env.GC_DIAG) {
            vm.call("_gc_diag"); // mark+drain 完、sweep 前：找 marked/根 → unmarked 边
        }

        vm.call("_gc_sweep");


        // gc_count++
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_GC_COUNT);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.V0, META_GC_COUNT, VReg.V1);

        // trigger = max(阈值, live_bytes)；alloc_since = 0
        // [GC_THRESHOLD] 与 init 处同一 env 可调值(此前只改 init → 首次 GC 后被重置回
        // 4GB,gc_count 恒 1,实验矩阵失真)。缺省 256MB nursery(与 init 一致,
        // 否则首个 full 后 minor 停摆)。
        vm.lea(VReg.V0, "_gc_live_bytes");
        vm.load(VReg.V1, VReg.V0, 0); // live
        {
            const thr = process.env.GC_DISABLE ? 0x800000000
                : (process.env.GC_THRESHOLD ? parseInt(process.env.GC_THRESHOLD, 10)
                    : (process.env.GC_FULLONLY ? GC_MIN_THRESHOLD : 268435456));
            vm.movImm64(VReg.V2, BigInt(thr));
        }
        vm.cmp(VReg.V1, VReg.V2);
        vm.jge("_gcc_settrig");
        vm.mov(VReg.V1, VReg.V2);
        vm.label("_gcc_settrig");
        vm.lea(VReg.V0, "_gc_trigger");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_alloc_since");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        // GOGC 步调重设:since_full=0,full_trigger = max(live×2, 512MB)
        {
            vm.lea(VReg.V0, "_gc_since_full");
            vm.movImm(VReg.V1, 0);
            vm.store(VReg.V0, 0, VReg.V1);
            vm.lea(VReg.V0, "_gc_live_bytes");
            vm.load(VReg.V1, VReg.V0, 0);
            vm.shlImm(VReg.V1, VReg.V1, 1); // live×2(GOGC=100)
            vm.movImm64(VReg.V2, BigInt(512 * 1024 * 1024));
            vm.cmp(VReg.V1, VReg.V2);
            vm.jge("_gcc_fulltrig");
            vm.mov(VReg.V1, VReg.V2);
            vm.label("_gcc_fulltrig");
            vm.lea(VReg.V0, "_gc_full_trigger");
            vm.store(VReg.V0, 0, VReg.V1);
        }

        // 分代状态推进(无 GC_GEN 也无害):full 后一切存活者皆 old,
        // young 起点=当前 heap_ptr,记忆集/溢出旗清零(位图刚重建,老边失效)
        vm.lea(VReg.V0, "_heap_ptr");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.lea(VReg.V0, "_gc_last_ptr");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_rs_clear_dedup"); // 清 RS 去重位(须在 rs_top=0 前)
        vm.movImm(VReg.V1, 0);
        vm.lea(VReg.V0, "_rs_top");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_rs_overflow");
        vm.store(VReg.V0, 0, VReg.V1);

        // gc_running = 0
        vm.lea(VReg.V0, "_heap_meta");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, META_GC_RUNNING, VReg.V1);

        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 0);
    }

    // _exit(code): 进程退出
    // A0 = exit code
    generateExit() {
        const vm = this.vm;
        const platform = vm.platform;
        const arch = vm.arch;

        vm.label("_exit");
        if (platform === "windows") {
            vm.callWindowsExitProcess();
        } else {
            // A0 已经是 exit code
            vm.syscall(this.getSyscallNum("exit"));
        }
        // 不需要 epilogue，因为程序已经退出
    }

    // 生成数据段定义
    generateDataSection(asm) {
        asm.addDataLabel("_heap_meta");
        for (let i = 0; i < META_SIZE / 8; i++) {
            asm.addDataQword(0);
        }

        asm.addDataLabel("_heap_ptr");
        asm.addDataQword(0);

        asm.addDataLabel("_heap_base");
        asm.addDataQword(0);

        // parseFloat 宽松解析开关:1 = _str_to_num 尾部遇非数字字符时不判 NaN,以已解析
        // 前缀收尾(parseFloat("3.14px")=3.14)。Number() 保持 0(严格,尾部垃圾→NaN)。
        asm.addDataLabel("_parse_lenient");
        asm.addDataQword(0);

        // [argc ABI] 调用点实参个数:每个 JS 调用点在装好 A0-A5 后、call 前写入
        // (compileCallArguments 系);需要实参个数的被调方(arguments 构建、Proxy
        // apply/construct 蹦床)在 prologue 立即读取。运行时 helper(vm.call)不触碰,
        // 故"调用点最后写、被调方最先读"窗口内恒新鲜。值 0-6 小整数,非指针,根扫描无害。
        asm.addDataLabel("_call_argc");
        asm.addDataQword(0);

        // [gen.return] 生成器 return(v) 注入通道:_generator_return 对挂起协程置
        // pending=1、value=v 后 resume;yield 恢复点(emitYieldValue)见 pending 即清零、
        // 取 value 作返回值、内联跑挂起点与函数出口间的 finalizer 后跳 returnLabel。
        // 单线程且"resume 前写、恢复点立即消费",无跨协程串扰。
        asm.addDataLabel("_gen_return_pending");
        asm.addDataQword(0);
        asm.addDataLabel("_gen_return_value");
        asm.addDataQword(0);

        // ---- GC 内部标量（都放在 [_heap_meta, _heap_meta_end) 跳过区内，
        //      不被根扫描当作指针误标；GC 代码通过 lea+load 直接读写它们）----
        asm.addDataLabel("_gc_mstack_base"); // 标记栈基址（独立 mmap 区）
        asm.addDataQword(0);
        asm.addDataLabel("_gc_mstack_top"); // 标记栈当前条目数
        asm.addDataQword(0);
        asm.addDataLabel("_gc_mstack_cap"); // 标记栈容量（条目数）
        asm.addDataQword(0);
        asm.addDataLabel("_gc_overflow"); // 标记栈溢出标志
        asm.addDataQword(0);
        asm.addDataLabel("_gc_alloc_since"); // 距上次 GC 已分配字节数
        asm.addDataQword(0);
        asm.addDataLabel("_gc_trigger"); // 触发阈值（alloc_since 超过则 GC）
        asm.addDataQword(0);
        asm.addDataLabel("_gc_live_bytes"); // sweep 阶段累计存活字节
        asm.addDataQword(0);
        asm.addDataLabel("_gc_bitmap_base"); // 标记位图基址（独立 mmap 区）
        asm.addDataQword(0);
        asm.addDataLabel("_gc_startmap_base"); // 块起始位图基址(内部指针解析用)
        asm.addDataQword(0);
        asm.addDataLabel("_rs_dedup_base"); // RS 去重位图基址(GC_GEN/SHADOW 下 mmap)
        asm.addDataQword(0);
        asm.addDataLabel("_gc_since_full"); // 自上次 full GC 的累计分配量(GOGC 步调)
        asm.addDataQword(0);
        asm.addDataLabel("_gc_full_trigger"); // full GC 触发额 = max(live×2, 下限)
        asm.addDataQword(0);
        // ---- span 页模型(#20 S1)----
        asm.addDataLabel("_gc_pagemap_base"); // 页映射基址(1B/64KB 页:0=非 span,1..18=class+1)
        asm.addDataQword(0);
        asm.addDataLabel("_span_cur"); // 每 class 的 span bump 游标(0=无活跃 span)
        for (let i = 0; i < NUM_SIZE_CLASSES; i++) asm.addDataQword(0);
        asm.addDataLabel("_span_end"); // 每 class 的 span 可用区终点
        for (let i = 0; i < NUM_SIZE_CLASSES; i++) asm.addDataQword(0);
        asm.addDataLabel("_gc_spanusable"); // 每 class 的 span 可用字节(编译期预算)
        for (let i = 0; i < NUM_SIZE_CLASSES; i++) asm.addDataQword(SPAN_USABLE[i]);
        // 分代 GC(#11 阶段b)
        asm.addDataLabel("_box_reg_base"); // box 登记表基址(64MB 惰性区)
        asm.addDataQword(0);
        asm.addDataLabel("_box_reg_top"); // 登记条数
        asm.addDataQword(0);
        asm.addDataLabel("_rs_base"); // 记忆集基址(128MB 惰性区)
        asm.addDataQword(0);
        asm.addDataLabel("_rs_top"); // 记忆集条数
        asm.addDataQword(0);
        asm.addDataLabel("_rs_overflow"); // 记忆集溢出旗(minor 须退化 full)
        asm.addDataQword(0);
        asm.addDataLabel("_gc_last_ptr"); // young 起点(上次 GC 后的 heap_ptr)
        asm.addDataQword(0);
        asm.addDataLabel("_shadow_base"); // [GC_SHADOW] 影子位图快照区基址
        asm.addDataQword(0);
        asm.addDataLabel("_shadow_miss"); // [GC_SHADOW] 累计漏标块数
        asm.addDataQword(0);

        // sweep 表驱动内联用:size/8 → class(65 字节;size 恒 8 对齐且 ≤512)
        asm.addDataLabel("_gc_s2c");
        for (let s8 = 0; s8 <= 64; s8++) {
            asm.addDataByte(s8 === 0 ? 0 : getSizeClass(s8 * 8));
        }
        // 对齐填充到 8 字节(65 → 72)
        for (let i = 0; i < 7; i++) asm.addDataByte(0);
        // class → class size(18 × 8 字节)
        asm.addDataLabel("_gc_c2s");
        for (let i = 0; i < NUM_SIZE_CLASSES; i++) {
            asm.addDataQword(SIZE_CLASSES[i]);
        }
        asm.addDataLabel("_gc_dbg_buf"); // [DEBUG] 单字节输出缓冲（GC_VALIDATE）
        asm.addDataQword(0);
        asm.addDataLabel("_gc_val_count"); // [DEBUG] 本轮 marked→unmarked 边计数
        asm.addDataQword(0);
        asm.addDataLabel("_gc_diag_buf"); // [DEBUG] 16 字节 hex 格式化缓冲（GC_DIAG / ALLOC_DBG）
        asm.addDataQword(0);
        asm.addDataQword(0);
        asm.addDataLabel("_alloc_dbg_lr"); // [DEBUG] ALLOC_DBG: _alloc 入口捕获的调用者返回地址
        asm.addDataQword(0);
        asm.addDataLabel("_alloc_dbg_fp"); // [DEBUG] ALLOC_DBG: _alloc 入口捕获的调用者帧指针(x29)
        asm.addDataQword(0);
        asm.addDataLabel("_gc_diag_startmap"); // [DEBUG] 块起始位图基址（GC_DIAG，懒 mmap）
        asm.addDataQword(0);
        asm.addDataLabel("_stack_base"); // 主线程初始 SP（栈根扫描上界），在 _start 记录
        asm.addDataQword(0);

        // 跳过区终点：根扫描遇到 [_heap_meta, _heap_meta_end) 会整体跳过，
        // 避免把 _heap_meta 里的 free-list 头/heap_size 等误当堆指针 → 误标损坏。
        // 需紧跟一处数据让该标签拿到具体偏移（两个 addDataLabel 连续时前者不会被赋偏移）。
        asm.addDataLabel("_heap_meta_end");
        asm.addDataQword(0); // 占位，同时是跳过区之后第一个被扫描的 qword（值 0，无害）

        // GC 寄存器根快照：_alloc 触发 GC 前把此刻仍持有 mutator 活值的调用者保存寄存器
        // (A0-A5, V4-V7) 存到这里，_gc_mark_roots 的数据段扫描会把它们当根扫（保守 GC 必须扫
        // 寄存器根，否则跨 _alloc 调用只在寄存器里的活指针会被漏标误回收）。10 个 qword。
        // 位于 _heap_meta_end 之后、_data_gc_end 之前 → 被根扫描覆盖。
        asm.addDataLabel("_gc_regsave");
        for (let i = 0; i < 10; i++) asm.addDataQword(0);

        // [M2] per-M 上下文块(§3.3)。GOMAXPROCS=1 唯一静态实例,_start 绑定到
        // 保留的 P/M 寄存器(arm64 x28)。位于 _heap_meta_end 之后 → 落 GC 根扫描区
        // (迁入的 exception_value/scheduler_current 等持活值,须当根)。未迁移槽恒 0 无害。
        asm.addDataLabel("_m0_context");
        for (let i = 0; i < MCTX_SIZE / 8; i++) asm.addDataQword(0);

        // NaN-boxing 单例值
        asm.addDataLabel("_js_true");
        asm.addDataQword(JS_TRUE);

        asm.addDataLabel("_js_false");
        asm.addDataQword(JS_FALSE);

        asm.addDataLabel("_js_null");
        asm.addDataQword(JS_NULL);

        asm.addDataLabel("_js_undefined");
        asm.addDataQword(JS_UNDEFINED);

        // Process global object pointer (initialized to null, runtime sets it)
        asm.addDataLabel("_process_global");
        asm.addDataQword(0);  // NULL - runtime will set this to the actual process object

        // globalThis 全局对象裸指针（运行时在 _process_init 里创建并写入）。
        // 位于 _data_gc_end 之前 → 被 GC 根扫描覆盖，其挂载的属性/回调不会被回收。
        asm.addDataLabel("_global_this");
        asm.addDataQword(0);  // NULL - runtime sets this to the actual global object

        // [shape v2 · T0] 形状转移表根(运行时首条转移边写入时惰性建表)。
        // 数据段锚槽 → 根扫描覆盖 → 表与堆上转移节点不被回收。见 SHAPE_TRANSITIONS_DESIGN.md §3/§4。
        asm.addDataLabel("_shape_transition_root");
        asm.addDataQword(0);  // NULL - 首次 _shape_transition_put 建表并写入

        // 事件循环队列（微任务 / setImmediate / setTimeout(0)）的单链表头尾指针。
        // 节点由 _ev_* 运行时函数分配；根扫描覆盖这些槽 → 队列中的回调/句柄存活。
        asm.addDataLabel("_ev_micro_head");
        asm.addDataQword(0);
        asm.addDataLabel("_ev_micro_tail");
        asm.addDataQword(0);
        asm.addDataLabel("_ev_imm_head");
        asm.addDataQword(0);
        asm.addDataLabel("_ev_imm_tail");
        asm.addDataQword(0);
        asm.addDataLabel("_ev_timeout_head");
        asm.addDataQword(0);
        asm.addDataLabel("_ev_timeout_tail");
        asm.addDataQword(0);

        // [#74] Promise 反应微任务队列头尾指针(GC 根扫描区,排队回调/结算值存活)。
        asm.addDataLabel("_promise_micro_head");
        asm.addDataQword(0);
        asm.addDataLabel("_promise_micro_tail");
        asm.addDataQword(0);

        // Module registry - stores pointers to exported module objects.
        // Size is derived from the resolved module graph so larger programs
        // do not overflow the old fixed 32-slot table.
        asm.addDataLabel("_module_registry");
        for (let i = 0; i < this.moduleRegistrySize; i++) {
            asm.addDataQword(0);  // NULL initially, runtime sets these
        }

        // [CJS cyclic require] Per-module lazy-init bookkeeping, parallel to
        // _module_registry (one slot per module index). Only local CommonJS
        // modules that participate in a require() cycle use these; all other
        // modules (ESM, acyclic CJS) keep the eager inline-body model and never
        // touch them. Placed adjacent to the registry so the same GC data-root
        // span keeps cached exports/errors reachable.
        //   _cjs_state:   0=uninitialized, 1=initializing, 2=done, 3=errored
        //   _cjs_exports: tagged module.exports JSValue (published at body entry
        //                 so a cyclic re-require sees the partial object)
        //   _cjs_error:   cached thrown value re-thrown on subsequent require
        asm.addDataLabel("_cjs_state");
        for (let i = 0; i < this.moduleRegistrySize; i++) asm.addDataQword(0);
        asm.addDataLabel("_cjs_exports");
        for (let i = 0; i < this.moduleRegistrySize; i++) asm.addDataQword(0);
        asm.addDataLabel("_cjs_error");
        for (let i = 0; i < this.moduleRegistrySize; i++) asm.addDataQword(0);
    }
}
