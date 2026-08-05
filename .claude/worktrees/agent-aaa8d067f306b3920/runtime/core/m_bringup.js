// asm.js 运行时 - 第二个 M(OS 线程)起跑管线(M3 预研,docs/PARALLEL_DESIGN.md §2.1/§4-M3)
// _m_thread_entry / _m_bringup_second / _m_bringup_smoke
//
// 目标:把 M3 的"第二个 M 起跑"接线到位 —— 线程入口蹦床把 x28 绑到第二个 M 的上下文块、
// 进调度环。**真正的多 M 调度/窃取属后续里程碑**;本文件只做起跑管线,且**默认关闭**:
// 起跑受 `_gomaxprocs` 门控(默认 1),编译产物内无路径改写它 → 单 M 定点默认零触达。
//
// 与 runtime/core/thread.js 的分工:thread.js 提供裸 clone()/futex/join 原语(已验证);
// 本文件在其上加"绑 x28 + 进调度环"的 M 语义蹦床。仅 linux-arm64/x64 有真体,其余目标
// (macos/windows/wasm)发恒返 -1 桩(段寄存器 TLS/私有线程 ABI 见 §2.2/§3.2,后置)。
//
// 已知局限(prep 阶段,故意):
// - 第二个 M 进 `_scheduler_run` 时,其就绪队列(现仍是全局 `_scheduler_ready_*`)与 M0
//   共享;冒烟场景下 M0 不在调度(仅 spawn+join),队列空 → 第二个 M 立即返回、线程退出。
//   真正的 per-P runq/窃取 = M3/M4 后续。
// - x64 无空闲 GPR,`bindMContext` 在 x64 是 no-op(段 TLS 后置)→ 第二个 M 在 x64 上暂
//   共享 M0 的扁平 per-M 槽(仅 arm64 起跑路径真正隔离)。文档化,不在本 prep 修。

import { VReg } from "../../vm/registers.js";
import { MCTX_PRINT_BUF, MCTX_SCHED_CURRENT, MCTX_SCHED_MAIN, MCTX_P } from "./allocator.js";
import { P_SIZE, P_G0_HI } from "./parallel_sched.js";

// 第二个 M 的上下文块:一次 mmap 一页,前 256B = M struct(布局同 _m0_context),
// 512 起 = 该 M 私有打印缓冲(避免与 M0 的 _print_buf_storage 撕裂),
// 1024 起 = 该 M 的 g0 协程块(第二个 M 的"主协程":_coroutine_resume 的 resumer,
//           只需 status/type + saved_sp/fp/resumer/exc 等可写槽;168B,在 M0 上预置)。
const M_CTX_ALLOC_SIZE = 4096;
const M_PRINT_BUF_OFF = 512;
const M_G0_OFF = 1024;

// 协程块字段(与 runtime/async/coroutine.js 一致)+ parallel_sched.js 的 P 布局。
const TYPE_COROUTINE = 10;
const CORO_STATUS_RUNNING = 1;
// P_SIZE 自 parallel_sched.js 导入(含 [M4] per-P mcache 后 = 2368);第二个 M 的 P =
// &_p_array[1] = _p_array + P_SIZE。单一真源避免与 P 结构布局漂移。

// linux 系统调用号(mmap;clone/futex/exit 在 thread.js)。局部常量,不碰分配器 Syscall 表。
const NR = { x64: { mmap: 9 }, arm64: { mmap: 222 } };

export class MBringupGenerator {
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
        this.generateMThreadEntry();
        this.generateMBringupAt();     // [M6] 起第 k 个 M(P 指针入参;N>2 一般化的单一真源)
        this.generateMBringupSecond(); // 委托 _m_bringup_at(&_p_array[1]),保 N=2 冒烟 ABI
        this.generateMBringupSmoke();
    }

    generateDataSection(asm) {
        // GOMAXPROCS 门:默认 1。仅 >1 时 `_m_bringup_second` 才真正起第二个 M。
        // 编译产物内无路径改写它(process.env 恒空)→ 单 M 定点默认零影响。非指针标量,
        // 落 GC 根扫描区无害(值 1/2 非堆指针)。
        asm.addDataLabel("_gomaxprocs");
        asm.addDataQword(1);
    }

    _stub(label) {
        const vm = this.vm;
        vm.label(label);
        vm.prologue(0, []);
        vm.movImm(VReg.RET, -1);
        vm.epilogue([], 0);
    }

    // _m_thread_entry(A0 = M 上下文块基址):线程入口蹦床。绑 x28 到本 M 的上下文,进多 M 调度环。
    // 全平台发射(标签须可解析);仅经 clone 子线程被调(linux)。x64 上 bindMContext 是 no-op。
    generateMThreadEntry() {
        const vm = this.vm;
        vm.label("_m_thread_entry");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);       // S0 = m_ctx(跨 bind 存活)
        vm.bindMContext(VReg.S0);        // arm64: mov x28, S0 → 本 M 的 per-M 槽全部随之切换
        // [M5] 记录本 M 的 g0(OS 线程)栈顶 → P.g0_hi(STW 扩展根扫描每 M g0 栈的高地址界)。
        // x28 已绑 → _m_current_p 取本 M 的 P(MCTX_P 在 _m_bringup_second 已置 &_p_array[1])。
        vm.lea(VReg.V0, "_m_current_p");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.mov(VReg.V1, VReg.SP);
        vm.store(VReg.V0, P_G0_HI, VReg.V1);
        vm.call("_par_sched_run");       // [M3] 进多 M 调度环(本地 runq→全局→窃取→计数0退出)
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);       // 返回后 _thread_create_raw 子路径 sys_exit 退线程
    }

    // _m_bringup_at(A0 = P 指针) -> RET = join 句柄(线程块基址)或 -1(门关/失败/非 linux)。
    // [M6 N>2] 起"以给定 P 为本地 P"的一个 M:mmap 其上下文块、初始化 per-M 指针化槽(打印缓冲)、
    // 预置 MCTX_P = 入参 P、g0 协程块与 scheduler_current/main,经 _thread_create_raw 起线程跑
    // _m_thread_entry。P 指针入参 → 调用者按 &_p_array[k] 分派任意第 k 个 M(N>2 一般化的单一真源)。
    generateMBringupAt() {
        const vm = this;
        const v = this.vm;
        if (!this.isLinux) {
            this._stub("_m_bringup_at");
            return;
        }
        v.label("_m_bringup_at");
        v.prologue(0, [VReg.S0, VReg.S1]);
        v.mov(VReg.S1, VReg.A0); // S1 = P 指针(callee-saved,跨 mmap syscall 存活)

        // GOMAXPROCS 门(默认 1 → 关闭)
        v.lea(VReg.V0, "_gomaxprocs");
        v.load(VReg.V0, VReg.V0, 0);
        v.cmpImm(VReg.V0, 1);
        v.jle("_m_bringup_disabled");

        // mmap M 上下文块(addr=0, len, RW=3, PRIVATE|ANON=0x22, fd=-1, off=0);MAP_ANON 清零
        v.movImm(VReg.A0, 0);
        v.movImm(VReg.A1, M_CTX_ALLOC_SIZE);
        v.movImm(VReg.A2, 3);
        v.movImm(VReg.A3, 0x22);
        v.movImm64(VReg.A4, 0xffffffffffffffffn); // fd=-1(全 1 正字面量,避 -1n 自举陷阱)
        v.movImm(VReg.A5, 0);
        v.syscall(vm.nr("mmap"));
        v.cmpImm(VReg.RET, 0);
        v.jle("_m_bringup_disabled"); // 裸 syscall 错误 = [-4095,-1];0 也拒
        v.mov(VReg.S0, VReg.RET);      // S0 = m_ctx 基址

        // 初始化本 M 的 per-M 指针化槽:print_buf 指针 = ctx + M_PRINT_BUF_OFF
        v.addImm(VReg.V1, VReg.S0, M_PRINT_BUF_OFF);
        v.store(VReg.S0, MCTX_PRINT_BUF, VReg.V1);

        // [M3] 预置该 M 的 per-P/协程上下文(M0 单线程写,线程起跑前):
        //  - MCTX_P = 入参 P(该 M 的本地 P;窃取从这里取本 M 的 P)
        v.store(VReg.S0, MCTX_P, VReg.S1);
        //  - g0 协程块 = ctx + M_G0_OFF;type=COROUTINE、status=RUNNING(其余槽 mmap 清零)
        v.addImm(VReg.V1, VReg.S0, M_G0_OFF);      // V1 = &g0
        v.movImm(VReg.V0, TYPE_COROUTINE);
        v.store(VReg.V1, 0, VReg.V0);
        v.movImm(VReg.V0, CORO_STATUS_RUNNING);
        v.store(VReg.V1, 8, VReg.V0);
        //  - scheduler_current = scheduler_main = g0(该 M resume 协程的 resumer 根)
        v.store(VReg.S0, MCTX_SCHED_CURRENT, VReg.V1);
        v.store(VReg.S0, MCTX_SCHED_MAIN, VReg.V1);

        // 起线程:入口 _m_thread_entry,实参 = m_ctx
        v.lea(VReg.A0, "_m_thread_entry");
        v.mov(VReg.A1, VReg.S0);
        v.call("_thread_create_raw"); // RET = 句柄或 -1
        v.jmp("_m_bringup_ret");

        v.label("_m_bringup_disabled");
        v.movImm(VReg.RET, -1);
        v.label("_m_bringup_ret");
        v.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _m_bringup_second() -> RET = join 句柄或 -1。委托 _m_bringup_at(&_p_array[1])(N=2 保持
    // 既有 ABI:M1/M3/M4/M5 冒烟仍调本函数)。GOMAXPROCS 门在 _m_bringup_at 内。
    generateMBringupSecond() {
        const v = this.vm;
        if (!this.isLinux) {
            this._stub("_m_bringup_second");
            return;
        }
        v.label("_m_bringup_second");
        v.prologue(0, []);
        v.lea(VReg.A0, "_p_array");
        v.addImm(VReg.A0, VReg.A0, P_SIZE); // &_p_array[1]
        v.call("_m_bringup_at");
        v.epilogue([], 0);
    }

    // _m_bringup_smoke() -> 0 成功 / -1。冒烟探针(shim 层原语,非用户 API):临时开门
    // GOMAXPROCS=2、经门控起第二个 M、join、复位 GOMAXPROCS=1。验证"第二个 M 绑 x28 +
    // 进调度环 + 退出 + join"全链。仅 linux 有真体。
    generateMBringupSmoke() {
        const v = this.vm;
        if (!this.isLinux) {
            this._stub("_m_bringup_smoke");
            return;
        }
        v.label("_m_bringup_smoke");
        v.prologue(0, [VReg.S0]);

        // 临时开门
        v.lea(VReg.V0, "_gomaxprocs");
        v.movImm(VReg.V1, 2);
        v.store(VReg.V0, 0, VReg.V1);

        v.call("_m_bringup_second");
        v.mov(VReg.S0, VReg.RET); // S0 = 句柄或 -1

        // 复位门 → 恢复默认单 M 语义
        v.lea(VReg.V0, "_gomaxprocs");
        v.movImm(VReg.V1, 1);
        v.store(VReg.V0, 0, VReg.V1);

        // 起线程成功则 join,否则失败
        v.cmpImm(VReg.S0, 0);
        v.jle("_m_smoke_fail");
        v.mov(VReg.A0, VReg.S0);
        v.call("_thread_join"); // CLEARTID futex join
        v.movImm(VReg.RET, 0);
        v.jmp("_m_smoke_ret");

        v.label("_m_smoke_fail");
        v.movImm(VReg.RET, -1);
        v.label("_m_smoke_ret");
        v.epilogue([VReg.S0], 0);
    }
}
