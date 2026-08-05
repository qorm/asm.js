// asm.js 运行时 - 裸 OS 线程原语(M3 预研,配方见 docs/PARALLEL_DESIGN.md §2.1)
// _thread_create_raw / _thread_join / _futex_wait / _futex_wake / _thread_smoke_child
//
// linux-arm64 / linux-x64 发射真实 clone()/futex 体;其余目标(macos/windows/wasm)
// 发射恒返 -1 的桩——同 winfs 模式:标签必须全平台可解析,但除非用户源码显式使用
// __thread_spawn_smoke/__thread_join 内建,这些函数是死代码,不接任何用户可见 API。
//
// 关键 ABI 事实(实现依据,勿凭记忆改):
// - clone 内核参数序按架构不同(musl clone.s 同序):
//     x64  : clone(flags, newsp, ptid, ctid, tls)   → A0..A4
//     arm64: clone(flags, newsp, ptid, tls, ctid)   → A0..A4(tls/ctid 互换!)
// - 子线程从 syscall 指令后继续执行:RET=0、SP=newsp,其余寄存器继承父线程
//   (x64 上 rcx/r11 被 syscall 指令毁,两侧皆然;S 寄存器两侧安全)。
// - CLONE_CHILD_CLEARTID:线程退出时内核向 ctid 写 32 位 0 并 FUTEX_WAKE(非
//   PRIVATE)。join 侧因此用**非 PRIVATE** 的 FUTEX_WAIT(op=0)稳配内核唤醒键。
// - join 字初始化为 qword 1:内核只清低 32 位,高 32 位恒 0 → 64 位 load 读 0
//   即已退出(该字只有 1/0 两态,不存真实 tid,免 CHILD_SETTID)。
// - sys_exit(非 exit_group)在 CLONE_THREAD 下只退出当前线程。

import { VReg } from "../../vm/registers.js";

// 线程块:一次 mmap,既当子栈又放 join 字/TLS 块。
//   +0          : join/ctid 字(qword,父初始化 1,内核退出清 0)
//   +256        : CLONE_SETTLS 用哑 TLS 块(冒烟线程不用 TSD,仅验证旗标)
//   +SIZE-32    : 子线程初始 SP(16 对齐;页对齐基址 + 1MB - 32)
const THREAD_STACK_SIZE = 1024 * 1024;
const THREAD_TLS_OFF = 256;
const THREAD_SP_MARGIN = 32;

// CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM
// |CLONE_SETTLS|CLONE_CHILD_CLEARTID(docs/PARALLEL_DESIGN.md §2.1)
const CLONE_FLAGS = 0x2d0f00;

// linux 系统调用号(x64 / arm64)。局部常量,不进 allocator 的 Syscall 表
// (本阶段铁律:不碰分配器/协程热路文件)。
const NR = {
    x64: { mmap: 9, clone: 56, futex: 202, exit: 60 },
    arm64: { mmap: 222, clone: 220, futex: 98, exit: 93 },
};

const FUTEX_WAIT = 0; // 非 PRIVATE,见文件头注释
const FUTEX_WAKE = 1;

export class ThreadGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    get isLinux() {
        return this.vm.platform === "linux" && (this.vm.arch === "arm64" || this.vm.arch === "x64");
    }

    nr(name) {
        return this.vm.arch === "arm64" ? NR.arm64[name] : NR.x64[name];
    }

    generate() {
        this.generateThreadCreateRaw();
        this.generateThreadJoin();
        this.generateFutexWait();
        this.generateFutexWake();
        this.generateThreadSmokeChild();
    }

    // 恒返 -1 桩(非 linux 目标;同 winfs._stub)
    _stub(label) {
        const vm = this.vm;
        vm.label(label);
        vm.prologue(0, []);
        vm.movImm(VReg.RET, -1);
        vm.epilogue([], 0);
    }

    // _thread_create_raw(A0=入口函数指针, A1=入口实参) -> RET = join 句柄(线程块基址)
    // 失败返回 -1。子线程:FP 清零 → 入口(A0=实参) → sys_exit(0)。
    generateThreadCreateRaw() {
        const vm = this.vm;
        if (!this.isLinux) {
            this._stub("_thread_create_raw");
            return;
        }
        vm.label("_thread_create_raw");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // S0 = 入口(跨 syscall 存活,子线程继承)
        vm.mov(VReg.S1, VReg.A1); // S1 = 实参

        // 线程块 mmap(addr=0, len, RW, MAP_PRIVATE|MAP_ANON=0x22, fd=-1, off=0)
        vm.movImm(VReg.A0, 0);
        vm.movImm(VReg.A1, THREAD_STACK_SIZE);
        vm.movImm(VReg.A2, 3);
        vm.movImm(VReg.A3, 0x22);
        vm.movImm64(VReg.A4, 0xffffffffffffffffn); // fd=-1(全 1 正字面量,避 -1n 自举陷阱)
        vm.movImm(VReg.A5, 0);
        vm.syscall(this.nr("mmap"));
        vm.cmpImm(VReg.RET, 0);
        vm.jle("_thrd_fail"); // 裸 syscall 错误 = [-4095,-1];0 也拒
        vm.mov(VReg.S2, VReg.RET); // S2 = 块基址

        // join 字 = 1(qword;内核 CLEARTID 清低 32 位 → 整 qword 归 0)
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.S2, 0, VReg.V1);

        // clone 参数(参数序见文件头)
        vm.movImm(VReg.A0, CLONE_FLAGS);
        vm.movImm(VReg.V1, THREAD_STACK_SIZE - THREAD_SP_MARGIN);
        vm.add(VReg.A1, VReg.S2, VReg.V1); // newsp = 基址+1MB-32(16 对齐)
        vm.movImm(VReg.A2, 0); // ptid 未用(无 PARENT_SETTID)
        if (this.vm.arch === "arm64") {
            vm.addImm(VReg.A3, VReg.S2, THREAD_TLS_OFF); // tls
            vm.mov(VReg.A4, VReg.S2); // ctid = 基址(join 字)
        } else {
            vm.mov(VReg.A3, VReg.S2); // ctid(vm.syscall 内部搬 rcx→r10)
            vm.addImm(VReg.A4, VReg.S2, THREAD_TLS_OFF); // tls
        }
        vm.syscall(this.nr("clone"));
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_thrd_child"); // 子线程路径(新栈)
        vm.jlt("_thrd_fail"); // 负 errno

        // 父线程:RET = 句柄(块基址)
        vm.mov(VReg.RET, VReg.S2);
        vm.jmp("_thrd_done");

        vm.label("_thrd_fail");
        vm.movImm(VReg.RET, -1);
        vm.label("_thrd_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // ---- 子线程:永不到达 epilogue。继承 S0=入口/S1=实参,SP=newsp,RET=0 ----
        vm.label("_thrd_child");
        vm.movImm(VReg.FP, 0); // 帧链断根(父 FP 指向父栈,不可继承)
        vm.mov(VReg.A0, VReg.S1);
        vm.callIndirect(VReg.S0); // 入口自带标准 prologue,在子栈上开帧
        vm.movImm(VReg.A0, 0);
        vm.syscall(this.nr("exit")); // sys_exit:CLONE_THREAD 下仅退出本线程
        // 不返回
    }

    // _thread_join(A0=句柄) -> 0。循环:join 字为 0 即退出;否则 FUTEX_WAIT 到
    // 内核 CLEARTID 唤醒。EAGAIN/EINTR 都自然回环重读。
    generateThreadJoin() {
        const vm = this.vm;
        if (!this.isLinux) {
            this._stub("_thread_join");
            return;
        }
        vm.label("_thread_join");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.label("_thrd_join_loop");
        vm.load(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_thrd_join_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.V1); // 期望值(只有 1/0 两态)
        vm.call("_futex_wait");
        vm.jmp("_thrd_join_loop");
        vm.label("_thrd_join_done");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
    }

    // _futex_wait(A0=地址, A1=期望值) -> syscall 返回值(0 / 负 errno)
    generateFutexWait() {
        const vm = this.vm;
        if (!this.isLinux) {
            this._stub("_futex_wait");
            return;
        }
        vm.label("_futex_wait");
        vm.prologue(0, []);
        vm.mov(VReg.A2, VReg.A1); // val
        vm.movImm(VReg.A1, FUTEX_WAIT); // op(非 PRIVATE,配内核 CLEARTID 唤醒)
        vm.movImm(VReg.A3, 0); // timeout = NULL
        vm.movImm(VReg.A4, 0);
        vm.movImm(VReg.A5, 0);
        vm.syscall(this.nr("futex"));
        vm.epilogue([], 0);
    }

    // _futex_wake(A0=地址, A1=唤醒数) -> 被唤醒的等待者数
    generateFutexWake() {
        const vm = this.vm;
        if (!this.isLinux) {
            this._stub("_futex_wake");
            return;
        }
        vm.label("_futex_wake");
        vm.prologue(0, []);
        vm.mov(VReg.A2, VReg.A1); // count
        vm.movImm(VReg.A1, FUTEX_WAKE);
        vm.movImm(VReg.A3, 0);
        vm.movImm(VReg.A4, 0);
        vm.movImm(VReg.A5, 0);
        vm.syscall(this.nr("futex"));
        vm.epilogue([], 0);
    }

    // _thread_smoke_child(A0=裸指针):向 [A0] 写字节 42。clone 冒烟测试的子线程入口
    // (不分配、不触 GC、不碰运行时全局——现阶段子线程唯一安全形态)。
    generateThreadSmokeChild() {
        const vm = this.vm;
        // 全平台同体(纯字节写,无 syscall):非 linux 下永不被调,保持标签可解析。
        vm.label("_thread_smoke_child");
        vm.prologue(0, []);
        vm.movImm(VReg.V1, 42);
        vm.storeByte(VReg.A0, 0, VReg.V1);
        vm.movImm(VReg.RET, 0);
        vm.epilogue([], 0);
    }
}
