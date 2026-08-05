// asm.js 运行时 - M3 真·多 M G-M-P 调度器(docs/PARALLEL_DESIGN.md §4-M3)
// per-P 运行队列 + 全局队列 + 工作窃取 + 原子自旋锁 + futex 空闲/唤醒 + 多 M 调度环。
//
// 门控:全部真体仅 **linux-arm64**(isParallel)发射;GOMAXPROCS=1 默认路径不触达
// (_scheduler_spawn 的 gomaxprocs>1 分支才路由到 _par_spawn;冒烟探针 __par_smoke 显式开门)。
// x64 多 M 走段寄存器 TLS(§3.2,后置)→ 本轮 x64/macos/wasm 发可解析的桩。
//
// 与既有单 M 调度器(runtime/async/coroutine.js 的 _scheduler_run/_scheduler_spawn,基于
// 全局链表 _scheduler_ready_*)的分工:那条路是 GOMAXPROCS=1 定点,逐字节不动;本文件是
// GOMAXPROCS>1 才走的**并行底盘**。
//
// M3 边界(M4/M5 territory,本轮**不**解决,冒烟以约束规避):
//  - 分配安全:第二个 M 上的 mcache 竞争未解 → **任务体不得分配**(纯计算 + 写预分配结果槽)。
//  - GC 安全:开门时把 _gc_trigger/_gc_full_trigger 调至无穷禁用 GC(§4-M3 过渡策略)→
//    任务协程相对上次 GC 恒 young → _coroutine_return 的 _gc_remember 提前返回、不写共享
//    记忆集 → 无竞争。任务体若分配/抛出则超出本轮契约。
//  - channel 跨 M 唤醒 = M6;本轮任务协程一律 run-to-completion(不 yield/await)。

import { VReg } from "../../vm/registers.js";
import { META_GC_COUNT } from "./allocator.js";
// per-M 槽偏移(MCTX_P=112 等)见 runtime/core/allocator.js 与 backend/arm64.js
// M_CTX_REDIRECT;本文件经 _m_current_p 标签(重定向到 x28+112)访问当前 M 的 P。

// ---- P struct 布局(静态数组 _p_array,P_MAX 份)----
const P_LOCK = 0;    // 自旋锁字(0=空闲,1=持有)
const P_HEAD = 8;    // 环形 deque 出队索引(单调递增)
const P_TAIL = 16;   // 环形 deque 入队索引(单调递增)
const P_RUNQ = 32;   // 运行队列环形数组起点(qword×RUNQ_CAP)
const RUNQ_CAP = 256;
const RUNQ_MASK = 255; // RUNQ_CAP-1(2 的幂 → 取模即按位与)
// [M4] per-P mcache:每 class 的 span bump 游标/终点(线程本地,分配快路零锁)。
// 与全局 `_span_cur`/`_span_end` 并存(GOMAXPROCS=1 仍走全局,单 M 定点逐字节不变);
// GOMAXPROCS>1 时 `_alloc` 小对象 bump 改走"当前 M 的 P"这两组数组(见 allocator.js
// `_alloc_small_mm`/`_mcache_refill`)。18 = NUM_SIZE_CLASSES。
const NUM_SIZE_CLASSES = 18;
export const P_MC_CUR = P_RUNQ + RUNQ_CAP * 8;          // 2080:mc span 游标[18]
export const P_MC_END = P_MC_CUR + NUM_SIZE_CLASSES * 8; // 2224:mc span 终点[18]
// [M5] safepoint 保存槽:M 在停点自存的执行栈 SP(STW 根扫描的每 M 栈起点)。
// P 天然 per-M(经 MCTX_P),故把 saved-SP 挂 P 上,避免动 backend M_CTX_REDIRECT。
export const P_SAVED_SP = P_MC_END + NUM_SIZE_CLASSES * 8; // 2368
// [M5] 每 M 栈上界(STW 扩展根扫描的每 M 栈终点,高地址)。park 时按当前执行栈(g0 或
// 协程栈)填 P_STACK_HI;P_G0_HI 是本 M g0(OS 线程)栈顶,`_m_thread_entry` 一次性记录,
// g0 停点(调度环圈首)直接取用。协程栈停点(refill)则取 `_scheduler_current` 协程的
// stack_base+stack_size。避免碰共享协程引擎(coroutine.js)即完成 §1.4 的"运行中 G 栈区间"。
export const P_G0_HI = P_SAVED_SP + 8;                   // 2376
export const P_STACK_HI = P_G0_HI + 8;                   // 2384
export const P_SIZE = P_STACK_HI + 8;                   // 2392
// [M6] N>2 一般化:P 注册表容量。GOMAXPROCS 上限 = P_MAX(启动 M 数 <= P_MAX)。
// `_p_array` 静态分配 P_MAX 份;调度环窃取遍历全部 P、STW 根扫描遍历全部 P(跳过自身/
// 未 park 者)。增大仅令 macos 数据段增长(全 0 槽,非 __text)→ 定点门只受数据布局影响。
export const P_MAX = 4;
// [M5] STW 请求者观测 parked 计数的自旋上限(纯安全网:防"目标 M 已退出"时死等;
// 正常路径停点很快达标)。到界即返 0(未达标)→ 冒烟报 park-not-observed(可见,不挂)。
const STW_SPIN_BOUND = 2000000000n;

// ---- 协程对象字段(与 runtime/async/coroutine.js 保持一致)----
const CORO_STATUS = 8;
const CORO_NEXT = 80;
const CORO_STATUS_COMPLETED = 3;

// ---- 冒烟参数 ----
const SMOKE_N = 16;
const SMOKE_EXPECTED = (SMOKE_N * (SMOKE_N + 1)) / 2; // task(i) 写 i+1 → Σ = 136
const SMOKE_BUSY = 100000; // 每任务忙等迭代数(增大两 M 交叠窗口;纯算术,不分配)

// [M4] 分配冒烟:每任务 alloc ALLOC_K 个 32B 节点,建单链表(node.next@0/tag@8),
// tag=i+1;再遍历求和 = K*(i+1)。结果只依赖 i(与两 M 交错无关)→ 确定性。
// 若并发 `_alloc` 返回重叠块(损坏),某节点 next/tag 被覆写 → 遍历和错 → 冒烟 FAIL。
const ALLOC_K = 64;
const ALLOC_NODE = 32; // 节点用户区字节(小对象,走 per-P mcache bump)
const ALLOC_EXPECTED = ALLOC_K * SMOKE_EXPECTED; // 64 * 136 = 8704

// [M5] 真 STW GC 冒烟:M0 主栈上经 mcache 建 KEEP_N 个 keeper 节点(node.next@0/tag@8,tag=j+1)
// 的活链表,头存数据槽 `_gc_keep_head`(→ GC 根)。校验和 = Σ(j+1) = KEEP_N*(KEEP_N+1)/2。
const KEEP_N = 64;
const KEEP_NODE = 16;
const KEEP_SUM = (KEEP_N * (KEEP_N + 1)) / 2; // 2080
const M0_GARBAGE = 512; // M0 主栈上分配、不保留的死节点(48B),给 GC 提供可回收对象

// linux 系统调用号无关(futex/clone/exit 在 thread.js)。

export class ParallelSchedGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    get isParallel() {
        return this.vm.platform === "linux" && this.vm.arch === "arm64";
    }

    _stub(label, ret) {
        const vm = this.vm;
        vm.label(label);
        vm.prologue(0, []);
        vm.movImm(VReg.RET, ret === undefined ? -1 : ret);
        vm.epilogue([], 0);
    }

    generate() {
        // 任务体是纯计算叶子(不 syscall / 不分配)→ 全平台发真体无害(仅冒烟调用)。
        this.generateSmokeTask();
        if (!this.isParallel) {
            // 非并行目标:发可解析的桩(_scheduler_spawn / _m_thread_entry / __par_smoke 引用)。
            this._stub("_par_spawn", 0);
            this._stub_void("_par_sched_run");
            this._stub("_par_smoke", -1);
            this._stub("_par_alloc_smoke", -1);
            this._stub("_par_stw_smoke", -1); // [M5] STW 冒烟(shim 引用,全平台可解析)
            this._stub("_par_gc_smoke", -1);  // [M5] 真 STW GC 冒烟(shim 引用)
            return;
        }
        this.generateAtomicAdd();
        this.generateSpinLock();
        this.generateSpinUnlock();
        this.generateGlobalPush();
        this.generateGlobalPop();
        this.generatePRunqPush();
        this.generatePRunqPop();
        this.generateParSpawn();
        this.generateParSchedRun();
        this.generateParSmoke();
        this.generateAllocTask();   // [M4] 分配型任务体
        this.generateParAllocSmoke(); // [M4] 分配冒烟编排
        this.generateSafepointPoll(); // [M5] 停点 poll + park/resume
        this.generateStwBegin();      // [M5] STW 请求者:置旗 + 等 park 达标
        this.generateStwEnd();        // [M5] STW 请求者:清旗 + 唤醒
        this.generateMStartExtras();  // [M6] 起 N-1 个额外 M(k=1..gomaxprocs-1)
        this.generateMJoinExtras();   // [M6] join N-1 个额外 M
        this.generateParStwSmoke();   // [M5] STW park/resume 往返冒烟(GC 仍 off)
        this.generateParGcSmoke();    // [M5] 真 STW GC 冒烟(GC-on:多 M 停世界收集)
    }

    _stub_void(label) {
        const vm = this.vm;
        vm.label(label);
        vm.prologue(0, []);
        vm.epilogue([], 0);
    }

    generateDataSection(asm) {
        // per-P 运行队列数组(锁 + 环形 deque)。GC 根扫描区内:槽持活协程指针 → 兼作根。
        // GOMAXPROCS=1 下恒空(_scheduler_spawn 不路由到此)→ 全 0,无害。
        asm.addDataLabel("_p_array");
        for (let i = 0; i < (P_SIZE * P_MAX) / 8; i++) asm.addDataQword(0);

        // 全局队列(加锁链表,复用协程 +80 next)+ 可运行 G 计数(终止判据 + futex 睡眠字)。
        asm.addDataLabel("_grq_lock");
        asm.addDataQword(0);
        asm.addDataLabel("_grq_head");
        asm.addDataQword(0);
        asm.addDataLabel("_grq_tail");
        asm.addDataQword(0);
        asm.addDataLabel("_grunnable");
        asm.addDataQword(0);

        // 当前 M 的 P 指针槽。arm64 经 MCTX_P=112 重定向到 x28(见 backend/arm64.js
        // M_CTX_REDIRECT);此扁平标签供非 arm64 后端解析(但其并行路径为桩,永不 lea)。
        asm.addDataLabel("_m_current_p");
        asm.addDataQword(0);

        // 冒烟结果缓冲(预分配,任务写各自槽 → 无竞争;M0 join 后求和校验)。
        asm.addDataLabel("_par_smoke_results");
        for (let i = 0; i < SMOKE_N; i++) asm.addDataQword(0);

        // [M4] 全局堆游标/span carve 锁:GOMAXPROCS>1 时序列化 `_mcache_refill` 与大对象
        // bump(两者都推进全局 `_heap_ptr`)。快路(P mcache 内 bump)不取此锁。GOMAXPROCS=1
        // 恒空(分配路径不取锁)。见 allocator.js `_mcache_refill`/`_alloc_large_bump`。
        asm.addDataLabel("_mheap_lock");
        asm.addDataQword(0);

        // [M4] 分配冒烟结果缓冲:每任务在自身 slot 写"链表标签和"(预分配,无竞争)。
        asm.addDataLabel("_par_alloc_results");
        for (let i = 0; i < SMOKE_N; i++) asm.addDataQword(0);

        // [M5] 协作式 safepoint / STW 协调槽(全平台声明,值 0;仅 linux-arm64 有读写体)。
        //  _stw_requested:STW 请求旗(1=请求全停;各 M 在停点 poll 到即 park)。兼 futex 睡眠字。
        //  _stw_parked   :已在停点 park 的 M 计数(原子增/减);请求者等它达到"其它 M 数"。
        //  _stw_park_observed:冒烟观测位——请求者见 parked 达标即置 1(证明 park/resume 往返生效)。
        // 均为标量,落 GC 根扫描区无害(0/1/2 非堆指针)。GOMAXPROCS=1 恒 0,单 M 定点零触达。
        asm.addDataLabel("_stw_requested");
        asm.addDataQword(0);
        asm.addDataLabel("_stw_parked");
        asm.addDataQword(0);
        asm.addDataLabel("_stw_park_observed");
        asm.addDataQword(0);

        // [M5] 真 STW GC 冒烟槽:_gc_keep_head = M0 keeper 活链表头(GC 根,落根扫描区 →
        // 收集时被标记存活);_gc_smoke_ran = 1 iff 显式 `_gc_collect` 使 gc_count 递增(真跑了 GC)。
        asm.addDataLabel("_gc_keep_head");
        asm.addDataQword(0);
        asm.addDataLabel("_gc_smoke_ran");
        asm.addDataQword(0);

        // [M6 N>2] 额外 M 的 join 句柄注册表(_m_handles[k]=第 k 个 M 线程块,k∈[1,P_MAX))。
        asm.addDataLabel("_m_handles");
        for (let i = 0; i < P_MAX; i++) asm.addDataQword(0);
    }

    // _atomic_add(A0=addr, A1=delta) -> RET=新值。LL/SC 原子加。叶子(无调用)。
    generateAtomicAdd() {
        const vm = this.vm;
        vm.label("_atomic_add");
        vm.label("_atomic_add_retry");
        vm.ldaxr(VReg.V0, VReg.A0);          // V0 = [addr]
        vm.add(VReg.V0, VReg.V0, VReg.A1);   // V0 += delta
        vm.stlxr(VReg.V1, VReg.V0, VReg.A0); // V1 = 状态(0=成功)
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_atomic_add_retry");
        vm.mov(VReg.RET, VReg.V0);
        vm.ret();
    }

    // _spin_lock(A0=lockaddr)。测试并置位自旋锁,acquire 语义。叶子。
    generateSpinLock() {
        const vm = this.vm;
        vm.label("_spin_lock");
        vm.label("_spin_lock_retry");
        vm.ldaxr(VReg.V0, VReg.A0);   // V0 = [lock]
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_spin_lock_busy");    // 已持有 → 放弃监视器后重试
        vm.movImm(VReg.V1, 1);
        vm.stlxr(VReg.V2, VReg.V1, VReg.A0); // 尝试置 1
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_spin_lock_retry");   // 丢失独占预约 → 重试
        vm.ret();                     // 获取(ldaxr 已给 acquire)
        vm.label("_spin_lock_busy");
        vm.clrex();
        vm.jmp("_spin_lock_retry");
    }

    // _spin_unlock(A0=lockaddr)。store-release 0。叶子。
    generateSpinUnlock() {
        const vm = this.vm;
        vm.label("_spin_unlock");
        vm.movImm(VReg.V0, 0);
        vm.stlr(VReg.V0, VReg.A0);
        vm.ret();
    }

    // _grq_push(A0=coro)。加锁尾插全局链表(coro+80=next)。不动计数(计数在 spawn 处)。
    generateGlobalPush() {
        const vm = this.vm;
        vm.label("_grq_push");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);          // S0 = coro(跨调用存活)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.S0, CORO_NEXT, VReg.V0); // coro.next = 0
        vm.lea(VReg.A0, "_grq_lock");
        vm.call("_spin_lock");
        vm.lea(VReg.V0, "_grq_tail");
        vm.load(VReg.V1, VReg.V0, 0);      // V1 = tail
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_grp_empty");
        vm.store(VReg.V1, CORO_NEXT, VReg.S0); // tail.next = coro
        vm.lea(VReg.V0, "_grq_tail");
        vm.store(VReg.V0, 0, VReg.S0);         // tail = coro
        vm.jmp("_grp_unlock");
        vm.label("_grp_empty");
        vm.lea(VReg.V0, "_grq_head");
        vm.store(VReg.V0, 0, VReg.S0);
        vm.lea(VReg.V0, "_grq_tail");
        vm.store(VReg.V0, 0, VReg.S0);
        vm.label("_grp_unlock");
        vm.lea(VReg.A0, "_grq_lock");
        vm.call("_spin_unlock");
        vm.epilogue([VReg.S0], 0);
    }

    // _grq_pop() -> RET=coro 或 0。加锁头出。
    generateGlobalPop() {
        const vm = this.vm;
        vm.label("_grq_pop");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.A0, "_grq_lock");
        vm.call("_spin_lock");
        vm.lea(VReg.V0, "_grq_head");
        vm.load(VReg.S0, VReg.V0, 0);      // S0 = head(跨 unlock 存活)
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_grpop_unlock");
        vm.load(VReg.V1, VReg.S0, CORO_NEXT); // V1 = head.next
        vm.lea(VReg.V0, "_grq_head");
        vm.store(VReg.V0, 0, VReg.V1);        // head = head.next
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_grpop_notempty");
        vm.lea(VReg.V0, "_grq_tail"); // 空了 → tail=0
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_grpop_notempty");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, CORO_NEXT, VReg.V1); // 清 next
        vm.label("_grpop_unlock");
        vm.lea(VReg.A0, "_grq_lock");
        vm.call("_spin_unlock");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);
    }

    // _p_runq_push(A0=P, A1=coro) -> RET(1=入本地环 / 0=满转全局)。
    generatePRunqPush() {
        const vm = this.vm;
        vm.label("_p_runq_push");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);          // S0 = P
        vm.mov(VReg.S1, VReg.A1);          // S1 = coro
        vm.mov(VReg.A0, VReg.S0);          // lock = P+P_LOCK(=P+0)
        vm.call("_spin_lock");
        vm.load(VReg.V0, VReg.S0, P_HEAD);
        vm.load(VReg.V1, VReg.S0, P_TAIL);
        vm.sub(VReg.V2, VReg.V1, VReg.V0); // count = tail-head
        vm.cmpImm(VReg.V2, RUNQ_CAP);
        vm.jge("_prp_full");
        vm.andImm(VReg.V2, VReg.V1, RUNQ_MASK); // idx = tail & mask
        vm.shlImm(VReg.V2, VReg.V2, 3);
        vm.add(VReg.V2, VReg.S0, VReg.V2);      // V2 = P + idx*8
        vm.store(VReg.V2, P_RUNQ, VReg.S1);     // runq[idx] = coro
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S0, P_TAIL, VReg.V1);     // tail++
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_spin_unlock");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_prp_full");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_spin_unlock");           // 先解 P 锁,再入全局(避免锁嵌套/死锁)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_grq_push");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _p_runq_pop(A0=P) -> RET=coro 或 0。头出(FIFO)。窃取 = 对他人 P 调用本函数(同锁,安全)。
    generatePRunqPop() {
        const vm = this.vm;
        vm.label("_p_runq_pop");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);          // S0 = P
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_spin_lock");
        vm.load(VReg.V0, VReg.S0, P_HEAD);
        vm.load(VReg.V1, VReg.S0, P_TAIL);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_prpop_empty");            // head==tail → 空
        vm.andImm(VReg.V2, VReg.V0, RUNQ_MASK); // idx = head & mask
        vm.shlImm(VReg.V2, VReg.V2, 3);
        vm.add(VReg.V2, VReg.S0, VReg.V2);
        vm.load(VReg.S1, VReg.V2, P_RUNQ); // S1 = coro(跨 unlock 存活)
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.S0, P_HEAD, VReg.V0); // head++
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_spin_unlock");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_prpop_empty");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_spin_unlock");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _par_spawn(A0=coro)。计数 +1、入当前 M 的 P 本地队列、唤醒空闲 M。
    // `js f(x)` 在 GOMAXPROCS>1 时由 _scheduler_spawn 路由至此(step 2)。
    generateParSpawn() {
        const vm = this.vm;
        vm.label("_par_spawn");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);          // S0 = coro
        // _grunnable += 1
        vm.lea(VReg.A0, "_grunnable");
        vm.movImm(VReg.A1, 1);
        vm.call("_atomic_add");
        // P = 当前 M 的 P(x28[MCTX_P],经 _m_current_p 重定向)
        vm.lea(VReg.V0, "_m_current_p");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_p_runq_push");
        // 唤醒可能在 _grunnable 上 futex 睡眠的空闲 M
        vm.lea(VReg.A0, "_grunnable");
        vm.movImm(VReg.A1, 0x7fffffff);
        vm.call("_futex_wake");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 0);
    }

    // _par_sched_run():多 M 调度环。当前 M 的 P 由 x28[MCTX_P] 取。
    //   本地 runq → 全局队列 → 窃取(另一 P)→ 无活可运行且计数=0 则退出,否则 futex 睡。
    //   运行=_coroutine_resume;协程完成则计数 -1 + 唤醒。
    generateParSchedRun() {
        const vm = this.vm;
        vm.label("_par_sched_run");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        vm.label("_psr_loop");
        // [M5] 停点:调度环每圈 poll 一次 STW 请求(此处不持锁、非协程栈内 → 天然停点)。
        // 快路(未请求)= 1 load + 1 branch;请求时 park(存 SP、原子增 parked、futex 睡)。
        vm.call("_safepoint_poll");
        // P = 当前 M 的 P
        vm.lea(VReg.V0, "_m_current_p");
        vm.load(VReg.S0, VReg.V0, 0);      // S0 = myP
        // 1) 本地 runq
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_p_runq_pop");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_psr_run");
        // 2) 全局队列
        vm.call("_grq_pop");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_psr_run");
        // 3) 窃取(N>2 一般化):遍历 _p_array 全部 P,跳过自身,对每个他人 P 调 pop。
        //    命中即运行;全部空 → 落到"无活"判据。S2 = 遍历指针(跨 _p_runq_pop 调用存活)。
        vm.lea(VReg.S2, "_p_array");       // S2 = &_p_array[0]
        vm.label("_psr_steal_loop");
        vm.lea(VReg.V0, "_p_array");
        vm.movImm(VReg.V1, P_SIZE * P_MAX);
        vm.add(VReg.V0, VReg.V0, VReg.V1); // V0 = &_p_array[P_MAX](尾)
        vm.cmp(VReg.S2, VReg.V0);
        vm.jge("_psr_steal_done");
        vm.cmp(VReg.S2, VReg.S0);
        vm.jeq("_psr_steal_next");         // 自身 P → 跳过
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_p_runq_pop");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_psr_run");
        vm.label("_psr_steal_next");
        vm.movImm(VReg.V0, P_SIZE);
        vm.add(VReg.S2, VReg.S2, VReg.V0);
        vm.jmp("_psr_steal_loop");
        vm.label("_psr_steal_done");
        // 4) 无活:计数=0 → 退出;否则 futex 睡待唤醒
        vm.lea(VReg.V0, "_grunnable");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_psr_exit");
        vm.lea(VReg.A0, "_grunnable");
        vm.mov(VReg.A1, VReg.V1);          // 期望值 = 刚观测值
        vm.call("_futex_wait");
        vm.jmp("_psr_loop");

        vm.label("_psr_run");
        vm.mov(VReg.S1, VReg.RET);         // S1 = g(协程)
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_coroutine_resume");
        // 完成?(status@+8 == COMPLETED)。run-to-completion 任务恒完成。
        vm.load(VReg.V0, VReg.S1, CORO_STATUS);
        vm.cmpImm(VReg.V0, CORO_STATUS_COMPLETED);
        vm.jne("_psr_requeue");
        // 计数 -1 + 唤醒(可能让空闲 M 观测到 0 而退出)
        vm.lea(VReg.A0, "_grunnable");
        vm.movImm64(VReg.A1, 0xffffffffffffffffn); // -1
        vm.call("_atomic_add");
        vm.lea(VReg.A0, "_grunnable");
        vm.movImm(VReg.A1, 0x7fffffff);
        vm.call("_futex_wake");
        vm.jmp("_psr_loop");
        vm.label("_psr_requeue");
        // 挂起(本轮任务不应发生;channel 跨 M = M6)→ 重入本地队列,不动计数
        vm.lea(VReg.V0, "_m_current_p");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_p_runq_push");
        vm.jmp("_psr_loop");

        vm.label("_psr_exit");
        vm.lea(VReg.A0, "_grunnable"); // 兜底唤醒其它空闲 M 观测 0
        vm.movImm(VReg.A1, 0x7fffffff);
        vm.call("_futex_wake");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _m_smoke_task(A0=i):冒烟任务协程体。忙等(交叠窗口)+ results[i]=i+1。纯计算,不分配。
    generateSmokeTask() {
        const vm = this.vm;
        vm.label("_m_smoke_task");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);          // S0 = i
        // 忙等 SMOKE_BUSY 次(纯算术,拉长任务体使两 M 交叠)
        vm.movImm(VReg.V0, 0);             // acc
        vm.movImm(VReg.V1, 0);             // j
        vm.movImm(VReg.V5, SMOKE_BUSY);    // 上限(> imm12,入寄存器比较)
        vm.label("_mst_spin");
        vm.cmp(VReg.V1, VReg.V5);
        vm.jge("_mst_done");
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.jmp("_mst_spin");
        vm.label("_mst_done");
        // results[i] = i+1
        vm.lea(VReg.V2, "_par_smoke_results");
        vm.shlImm(VReg.V3, VReg.S0, 3);
        vm.add(VReg.V2, VReg.V2, VReg.V3);
        vm.addImm(VReg.V4, VReg.S0, 1);
        vm.store(VReg.V2, 0, VReg.V4);
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 0);
    }

    // _par_smoke() -> RET(0=成功 / -1=校验失败)。GOMAXPROCS=2 下起第二个 M、跑 N 个任务协程
    // 分布到两 M、join、校验 Σresults==136。M0 侧编排(见文件头 M3 边界)。
    generateParSmoke() {
        const vm = this.vm;
        vm.label("_par_smoke");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        // 开门 GOMAXPROCS = nprocs(A0 参数;__par_smoke→2、__par_smoke_n→3)
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.store(VReg.V0, 0, VReg.A0);
        // 禁用 GC(阈值 → 无穷;§4-M3 过渡策略)
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.lea(VReg.V0, "_gc_trigger");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_full_trigger");
        vm.store(VReg.V0, 0, VReg.V1);
        // M0 的 P = &_p_array[0]
        vm.lea(VReg.V0, "_m_current_p");
        vm.lea(VReg.V1, "_p_array");
        vm.store(VReg.V0, 0, VReg.V1);
        // 清结果缓冲
        vm.movImm(VReg.S0, 0);
        vm.label("_ps_clear");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_ps_clear_done");
        vm.lea(VReg.V0, "_par_smoke_results");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V2, 0);
        vm.store(VReg.V0, 0, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_ps_clear");
        vm.label("_ps_clear_done");

        // 建 + 派发 N 个任务协程(M0 单线程分配;经 _scheduler_spawn 路由到 _par_spawn → P0)
        vm.movImm(VReg.S0, 0);
        vm.label("_ps_spawn");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_ps_spawn_done");
        vm.lea(VReg.A0, "_m_smoke_task");
        vm.mov(VReg.A1, VReg.S0);          // arg = i
        vm.movImm(VReg.A2, 0);             // closure = 0
        vm.call("_coroutine_create");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_scheduler_spawn");       // gomaxprocs>1 → _par_spawn(step 2 路径)
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_ps_spawn");
        vm.label("_ps_spawn_done");

        // 起 N-1 个额外 M,M0 亦跑调度环排空 + 被窃取,再 join 全部额外 M
        vm.call("_m_start_extras");
        vm.call("_par_sched_run");
        vm.call("_m_join_extras");

        // 复位 GOMAXPROCS=1(GC 保持禁用,进程将尽)
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);

        // 校验 Σresults == 136
        vm.movImm(VReg.S0, 0);             // i
        vm.movImm(VReg.S2, 0);             // sum
        vm.label("_ps_sum");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_ps_sum_done");
        vm.lea(VReg.V0, "_par_smoke_results");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0);
        vm.add(VReg.S2, VReg.S2, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_ps_sum");
        vm.label("_ps_sum_done");
        vm.movImm(VReg.V0, SMOKE_EXPECTED);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jeq("_ps_ok");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_ps_ok");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // [M4] _m_alloc_task(A0=i):分配型任务协程体。alloc K 个节点建链表(每节点写自己的
    // tag=i+1),再遍历求和。全程只碰自身新分配的 young 节点 → 写点屏障 `_gc_remember`
    // 恒早退(young 容器不入记忆集)→ 无共享 GC 态竞争。`_alloc` 小对象走当前 M 的 P
    // mcache(无锁快路)+ 锁保护的 `_mcache_refill`。run-to-completion(不 yield)。
    generateAllocTask() {
        const vm = this.vm;
        vm.label("_m_alloc_task");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);          // S0 = i
        vm.movImm(VReg.S1, 0);             // S1 = head(链表头)
        vm.movImm(VReg.S2, 0);             // S2 = j
        vm.label("_mat_build");
        vm.cmpImm(VReg.S2, ALLOC_K);
        vm.jge("_mat_walk");
        vm.movImm(VReg.A0, ALLOC_NODE);
        vm.call("_alloc");                 // RET = 节点用户区(经 per-P mcache)
        vm.store(VReg.RET, 0, VReg.S1);    // node.next = head
        vm.addImm(VReg.V0, VReg.S0, 1);
        vm.store(VReg.RET, 8, VReg.V0);    // node.tag = i+1
        vm.mov(VReg.S1, VReg.RET);         // head = node
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.jmp("_mat_build");
        vm.label("_mat_walk");
        vm.movImm(VReg.S3, 0);             // S3 = sum
        vm.mov(VReg.S2, VReg.S1);          // S2 = cur = head
        vm.label("_mat_wloop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_mat_wdone");
        vm.load(VReg.V0, VReg.S2, 8);      // tag
        vm.add(VReg.S3, VReg.S3, VReg.V0);
        vm.load(VReg.S2, VReg.S2, 0);      // cur = cur.next
        vm.jmp("_mat_wloop");
        vm.label("_mat_wdone");
        vm.lea(VReg.V2, "_par_alloc_results");
        vm.shlImm(VReg.V3, VReg.S0, 3);
        vm.add(VReg.V2, VReg.V2, VReg.V3);
        vm.store(VReg.V2, 0, VReg.S3);     // results[i] = sum(= K*(i+1))
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // [M4] _par_alloc_smoke() -> 0/-1。GOMAXPROCS=2 + 禁 GC 下起第二个 M、跑 N 个**分配型**
    // 任务分布两 M(per-P runq + 窃取)、join、校验 Σresults == K*136。与 _par_smoke 同编排,
    // 仅任务体换成 _m_alloc_task(每任务并发 `_alloc` → 检验 per-P mcache 多 M 分配安全)。
    generateParAllocSmoke() {
        const vm = this.vm;
        vm.label("_par_alloc_smoke");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        // 开门 GOMAXPROCS=2
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.movImm(VReg.V1, 2);
        vm.store(VReg.V0, 0, VReg.V1);
        // 禁用 GC(阈值 → 无穷;§4-M4 过渡策略:GC-off,STW 属 M5)
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.lea(VReg.V0, "_gc_trigger");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_full_trigger");
        vm.store(VReg.V0, 0, VReg.V1);
        // M0 的 P = &_p_array[0]
        vm.lea(VReg.V0, "_m_current_p");
        vm.lea(VReg.V1, "_p_array");
        vm.store(VReg.V0, 0, VReg.V1);
        // 清结果缓冲
        vm.movImm(VReg.S0, 0);
        vm.label("_pas_clear");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pas_clear_done");
        vm.lea(VReg.V0, "_par_alloc_results");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V2, 0);
        vm.store(VReg.V0, 0, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pas_clear");
        vm.label("_pas_clear_done");

        // 建 + 派发 N 个分配型任务协程(M0 单线程分配协程壳;经 _scheduler_spawn → P0)
        vm.movImm(VReg.S0, 0);
        vm.label("_pas_spawn");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pas_spawn_done");
        vm.lea(VReg.A0, "_m_alloc_task");
        vm.mov(VReg.A1, VReg.S0);          // arg = i
        vm.movImm(VReg.A2, 0);             // closure = 0
        vm.call("_coroutine_create");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_scheduler_spawn");       // gomaxprocs>1 → _par_spawn
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pas_spawn");
        vm.label("_pas_spawn_done");

        // 起第二个 M,M0 亦跑调度环,再 join
        vm.call("_m_bringup_second");
        vm.mov(VReg.S1, VReg.RET);         // S1 = join 句柄或 -1
        vm.call("_par_sched_run");         // M0 排空 P0 + 被 M1 窃取
        vm.cmpImm(VReg.S1, 0);
        vm.jle("_pas_no_join");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_thread_join");
        vm.label("_pas_no_join");

        // 复位 GOMAXPROCS=1(GC 保持禁用,进程将尽)
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);

        // 校验 Σresults == ALLOC_EXPECTED
        vm.movImm(VReg.S0, 0);             // i
        vm.movImm(VReg.S2, 0);             // sum
        vm.label("_pas_sum");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pas_sum_done");
        vm.lea(VReg.V0, "_par_alloc_results");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0);
        vm.add(VReg.S2, VReg.S2, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pas_sum");
        vm.label("_pas_sum_done");
        vm.movImm(VReg.V0, ALLOC_EXPECTED);
        vm.cmp(VReg.S2, VReg.V0);
        vm.jeq("_pas_ok");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_pas_ok");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // [M5] _safepoint_poll():协作式停点。快路——`_stw_requested`==0 直接返回(1 load+1 branch)。
    // 请求时:把本 M 当前 SP 存入其 P.saved_sp(未来 STW 根扫描的每 M 栈起点)、原子增 `_stw_parked`、
    // futex 睡在 `_stw_requested`(睡到请求者清 0 并 wake)、醒后原子减 `_stw_parked` 返回。
    // 只碰 A/V 暂存器 + 调用 helper;不用 S 寄存器 → 调用者的 callee-saved 值天然保活。
    // 仅在"不持锁、不在协程栈内"的天然停点插(调度环圈首 + 分配慢路 refill 入口)。
    // 注意(本轮 GC-off):park 时只存 SP、尚不 spill mutator 寄存器根——真 STW 扫描前需补
    // 每 M 寄存器 spill 区(见 PARALLEL_DESIGN.md §4-M5 "剩余工作")。
    generateSafepointPoll() {
        const vm = this.vm;
        vm.label("_safepoint_poll");
        vm.prologue(0, []); // 非叶(调 _atomic_add/_futex_wait)→ 存 FP/LR
        vm.lea(VReg.V0, "_stw_requested");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_sp_ret"); // 快路:未请求
        // ---- park ----
        // 存 SP → 当前 M 的 P.saved_sp(P 经 _m_current_p 重定向 x28+MCTX_P)
        vm.lea(VReg.V1, "_m_current_p");
        vm.load(VReg.V1, VReg.V1, 0);       // V1 = P
        vm.mov(VReg.V0, VReg.SP);
        vm.store(VReg.V1, P_SAVED_SP, VReg.V0);
        // [M5] 记录当前执行栈上界 → P.stack_hi(STW 扩展根扫描的每 M 栈终点)。
        // 现执行栈 = g0 主栈(scheduler_current==scheduler_main)则取 P.g0_hi(线程入口记的顶);
        // 否则在协程栈上(refill 停点)→ 取运行中协程的 stack_base+stack_size(§1.4 运行中 G 栈区间)。
        vm.lea(VReg.V2, "_scheduler_current");
        vm.load(VReg.V2, VReg.V2, 0);       // V2 = cur coro
        vm.lea(VReg.V3, "_scheduler_main");
        vm.load(VReg.V3, VReg.V3, 0);       // V3 = g0(本 M 主协程)
        vm.cmp(VReg.V2, VReg.V3);
        vm.jeq("_sp_hi_g0");
        vm.load(VReg.V4, VReg.V2, 16);      // coro.stack_base
        vm.load(VReg.V5, VReg.V2, 24);      // coro.stack_size
        vm.add(VReg.V4, VReg.V4, VReg.V5);  // coro 栈顶(高地址)
        vm.jmp("_sp_hi_set");
        vm.label("_sp_hi_g0");
        vm.load(VReg.V4, VReg.V1, P_G0_HI); // g0 栈顶(_m_thread_entry 记)
        vm.label("_sp_hi_set");
        vm.store(VReg.V1, P_STACK_HI, VReg.V4);
        // parked += 1
        vm.lea(VReg.A0, "_stw_parked");
        vm.movImm(VReg.A1, 1);
        vm.call("_atomic_add");
        // futex 睡:睡到 `_stw_requested` != 1(请求者清 0)
        vm.label("_sp_wait");
        vm.lea(VReg.V0, "_stw_requested");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_sp_resume"); // 已清 0 → 无需/不再睡(先查后睡,免丢唤醒)
        vm.lea(VReg.A0, "_stw_requested");
        vm.movImm(VReg.A1, 1);
        vm.call("_futex_wait"); // 值!=1 立即返;否则睡到 wake
        vm.jmp("_sp_wait");
        vm.label("_sp_resume");
        // [M6 N>2] 清本 M 的 P.saved_sp = 0(标记"已离开停点、正在运行")。协调者已在
        // _stw_end 唤醒前完成扩展根扫描,故此清 0 不与扫描竞争;而清 0 保证**后续**的 GC 周期
        // 里 `_gc_scan_other_ms` 不会误扫一个已 resume、正在运行的 M 的陈旧 [saved_sp,stack_hi)
        // (N=2 单次 GC 无此问题,但 N>2 多周期必须)。P 经 _m_current_p 重定向 x28+MCTX_P。
        vm.lea(VReg.V1, "_m_current_p");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V1, P_SAVED_SP, VReg.V0);
        // parked -= 1
        vm.lea(VReg.A0, "_stw_parked");
        vm.movImm64(VReg.A1, 0xffffffffffffffffn); // -1
        vm.call("_atomic_add");
        vm.label("_sp_ret");
        vm.epilogue([], 0);
    }

    // [M5] _stw_begin(A0=target):STW 请求者。置 `_stw_requested`=1(release),自旋等
    // `_stw_parked` >= target(= 需停的其它 M 数),达标置 `_stw_park_observed`=1 返 1;
    // 到自旋上限仍未达标(目标 M 已退出等)返 0。请求者自身**不**经停点(不在调度环里 poll)。
    // 达标后请求者独占世界:可安全扫根/回收(真 STW GC = M5 后续),然后 _stw_end 释放。
    generateStwBegin() {
        const vm = this.vm;
        vm.label("_stw_begin");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // S0 = target
        // requested = 1(release,确保 park 侧看见)
        vm.lea(VReg.V0, "_stw_requested");
        vm.movImm(VReg.V1, 1);
        vm.stlr(VReg.V1, VReg.V0);
        // S1 = 自旋预算
        vm.movImm64(VReg.S1, STW_SPIN_BOUND);
        vm.label("_stwb_spin");
        vm.cmpImm(VReg.S1, 0);
        vm.jle("_stwb_timeout");
        vm.subImm(VReg.S1, VReg.S1, 1);
        // [M6 N>2] sched_yield(arm64 №124):让出 CPU,避免请求者热自旋饿死尚未 park 的额外 M
        // (N>2 下多个 worker M 需被调度到停点;CPU 超订时热自旋会推迟其 park → 自旋预算耗尽误判
        // 超时)。清 A0-A5(sched_yield 无参),svc 不动 x28/S0/S1。仅 linux-arm64 发射。
        vm.syscall(124);
        vm.lea(VReg.V0, "_stw_parked");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmp(VReg.V1, VReg.S0);
        vm.jlt("_stwb_spin");
        // 达标:置观测位,返 1
        vm.lea(VReg.V0, "_stw_park_observed");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_stwb_timeout");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [M5] _stw_end():释放全停。清 `_stw_requested`=0(release)+ futex 唤醒所有 park 的 M。
    generateStwEnd() {
        const vm = this.vm;
        vm.label("_stw_end");
        vm.prologue(0, []);
        vm.lea(VReg.V0, "_stw_requested");
        vm.movImm(VReg.V1, 0);
        vm.stlr(VReg.V1, VReg.V0); // requested = 0(release)
        vm.lea(VReg.A0, "_stw_requested");
        vm.movImm(VReg.A1, 0x7fffffff);
        vm.call("_futex_wake");
        vm.epilogue([], 0);
    }

    // [M6 N>2] _m_start_extras():起 N-1 个额外 M(k=1..gomaxprocs-1),各绑 &_p_array[k]
    // (`_m_bringup_at`),句柄存 _m_handles[k]。N=2 时循环恰跑 1 圈(等价旧 _m_bringup_second)。
    generateMStartExtras() {
        const vm = this.vm;
        vm.label("_m_start_extras");
        vm.prologue(0, [VReg.S0]);
        vm.movImm(VReg.S0, 1); // k
        vm.label("_mse_loop");
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_mse_done");
        vm.lea(VReg.A0, "_p_array");
        vm.movImm(VReg.V1, P_SIZE);
        vm.mul(VReg.V2, VReg.S0, VReg.V1);
        vm.add(VReg.A0, VReg.A0, VReg.V2); // &_p_array[k]
        vm.call("_m_bringup_at");
        vm.lea(VReg.V0, "_m_handles");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.store(VReg.V0, 0, VReg.RET); // _m_handles[k] = 句柄
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_mse_loop");
        vm.label("_mse_done");
        vm.epilogue([VReg.S0], 0);
    }

    // [M6 N>2] _m_join_extras():join 全部额外 M(k=1..gomaxprocs-1),句柄取自 _m_handles[k]。
    generateMJoinExtras() {
        const vm = this.vm;
        vm.label("_m_join_extras");
        vm.prologue(0, [VReg.S0]);
        vm.movImm(VReg.S0, 1);
        vm.label("_mje_loop");
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jge("_mje_done");
        vm.lea(VReg.V0, "_m_handles");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.A0, VReg.V0, 0);
        vm.cmpImm(VReg.A0, 0);
        vm.jle("_mje_next");
        vm.call("_thread_join");
        vm.label("_mje_next");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_mje_loop");
        vm.label("_mje_done");
        vm.epilogue([VReg.S0], 0);
    }

    // [M5] _par_stw_smoke() -> 0/-1。GOMAXPROCS=2 + GC-off:起第二个 M 跑非分配任务,
    // M0 作请求者跑一次 STW 往返(_stw_begin(1) → 等 M1 在停点 park → _stw_end 唤醒),
    // 再与 M1 一同排空 16 个任务、join、校验 Σresults==136 且 park 往返被观测(observed==1)。
    // 证明协作式停点机制端到端生效(M1 在调度环圈首 poll 到请求即 park,被唤醒后继续排空)。
    // 真 STW GC(请求者达标后跑扩展根扫描 + 回收)= M5 后续(见 PARALLEL_DESIGN.md §4-M5)。
    generateParStwSmoke() {
        const vm = this.vm;
        vm.label("_par_stw_smoke");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        // 开门 GOMAXPROCS=2
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.movImm(VReg.V1, 2);
        vm.store(VReg.V0, 0, VReg.V1);
        // 禁用 GC(阈值 → 无穷;本轮 STW 只验 park/resume,回收属后续)
        vm.movImm64(VReg.V1, 0x7fffffffffffffffn);
        vm.lea(VReg.V0, "_gc_trigger");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_full_trigger");
        vm.store(VReg.V0, 0, VReg.V1);
        // 复位 STW 槽
        vm.movImm(VReg.V1, 0);
        vm.lea(VReg.V0, "_stw_requested");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_stw_parked");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_stw_park_observed");
        vm.store(VReg.V0, 0, VReg.V1);
        // M0 的 P = &_p_array[0]
        vm.lea(VReg.V0, "_m_current_p");
        vm.lea(VReg.V1, "_p_array");
        vm.store(VReg.V0, 0, VReg.V1);
        // 清结果缓冲
        vm.movImm(VReg.S0, 0);
        vm.label("_pss_clear");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pss_clear_done");
        vm.lea(VReg.V0, "_par_smoke_results");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V2, 0);
        vm.store(VReg.V0, 0, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pss_clear");
        vm.label("_pss_clear_done");

        // 建 + 派发 N 个非分配任务协程(M0 单线程分配壳;经 _scheduler_spawn → P0)
        vm.movImm(VReg.S0, 0);
        vm.label("_pss_spawn");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pss_spawn_done");
        vm.lea(VReg.A0, "_m_smoke_task");
        vm.mov(VReg.A1, VReg.S0);
        vm.movImm(VReg.A2, 0);
        vm.call("_coroutine_create");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_scheduler_spawn"); // gomaxprocs>1 → _par_spawn → P0
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pss_spawn");
        vm.label("_pss_spawn_done");

        // 起第二个 M(进 _par_sched_run(P1);圈首会 poll STW)
        vm.call("_m_bringup_second");
        vm.mov(VReg.S1, VReg.RET); // S1 = join 句柄或 -1

        // ---- STW 往返:M0 作请求者 ----
        // _stw_begin(1):置旗 + 等 M1 在停点 park(其调度环圈首 poll 到 → park,parked=1)。
        // M1 起跑先绕行 poll(此刻旗未置)开始跑任务;begin 置旗后 M1 下一圈首 poll 即 park。
        // 长任务(SMOKE_BUSY)保证 M1 尚未排空即被停点截住(同 M3/M4 冒烟的交叠窗口方法)。
        vm.movImm(VReg.A0, 1);
        vm.call("_stw_begin");
        vm.mov(VReg.S2, VReg.RET); // S2 = 1 达标 / 0 超时(记为 park 未观测)
        // 全停期间(本轮不回收,占位:真 GC 在此扫根+sweep)→ 直接释放
        vm.call("_stw_end"); // 清旗 + 唤醒 M1 继续排空

        // M0 亦跑调度环排空 P0(此刻旗已清 → M0 poll 不 park),再 join M1
        vm.call("_par_sched_run");
        vm.cmpImm(VReg.S1, 0);
        vm.jle("_pss_no_join");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_thread_join");
        vm.label("_pss_no_join");

        // 复位 GOMAXPROCS=1
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);

        // 校验 Σresults == 136
        vm.movImm(VReg.S0, 0);
        vm.movImm(VReg.S1, 0); // sum(S1 复用:join 已完成)
        vm.label("_pss_sum");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pss_sum_done");
        vm.lea(VReg.V0, "_par_smoke_results");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0);
        vm.add(VReg.S1, VReg.S1, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pss_sum");
        vm.label("_pss_sum_done");
        // 需同时:sum==136 且 STW 往返被观测(S2==1 且 _stw_park_observed==1)
        vm.movImm(VReg.V0, SMOKE_EXPECTED);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jne("_pss_fail");
        vm.cmpImm(VReg.S2, 1);
        vm.jne("_pss_fail");
        vm.lea(VReg.V0, "_stw_park_observed");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_pss_fail");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
        vm.label("_pss_fail");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // [M5] _par_gc_smoke() -> 0/-1。**真·多 M STW GC 冒烟**(§4-M5 目标兑现):GOMAXPROCS=2、
    // GC-ON 下,M0(主栈=协调者)经 mcache 建 keeper 活链表(头存数据槽 → GC 根)+ 一批死垃圾,
    // 派发 N 个分配型任务到 P0,**预置 STW 请求旗后**起第二个 M —— M1 在 `_par_sched_run` 首个
    // 圈首停点即 park(g0 栈,未跑任何任务,确定性)。M0 `_stw_begin(1)` 等 M1 park 达标后独占世界,
    // 显式 `_gc_collect`(数据段 keeper+runq 根 + M0 主栈 + `_gc_scan_other_ms` 扫 M1 g0 栈 → mark;
    // sweep 线性走含 mcache span 的堆,piece#1 哨兵/pagemap 使其可走/可解析),`_stw_end` 唤醒 M1;
    // 两 M 排空任务、join。校验:① keeper 校验和 == KEEP_SUM(活链表跨 GC 存活)② 任务结果 Σ ==
    // ALLOC_EXPECTED ③ gc_count 递增(真跑了一轮 GC)。任一不符 → -1。仅 linux-arm64 有真体。
    generateParGcSmoke() {
        const vm = this.vm;
        vm.label("_par_gc_smoke");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        // 开门 GOMAXPROCS = nprocs(A0 参数;GC 保持 ON:显式 _gc_collect 驱动收集)
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.store(VReg.V0, 0, VReg.A0);
        // 复位 STW / 冒烟槽
        vm.movImm(VReg.V1, 0);
        vm.lea(VReg.V0, "_stw_requested");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_stw_parked");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_stw_park_observed");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_smoke_ran");
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_gc_keep_head");
        vm.store(VReg.V0, 0, VReg.V1);
        // M0 的 P = &_p_array[0]
        vm.lea(VReg.V0, "_m_current_p");
        vm.lea(VReg.V1, "_p_array");
        vm.store(VReg.V0, 0, VReg.V1);
        // 清任务结果缓冲
        vm.movImm(VReg.S0, 0);
        vm.label("_pgs_clear");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pgs_clear_done");
        vm.lea(VReg.V0, "_par_alloc_results");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm(VReg.V2, 0);
        vm.store(VReg.V0, 0, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pgs_clear");
        vm.label("_pgs_clear_done");

        // ---- M0 主栈上建 keeper 活链表(经 mcache;头存数据槽 → GC 根)----
        vm.movImm(VReg.S1, 0); // head
        vm.movImm(VReg.S0, 0); // j
        vm.label("_pgs_keep");
        vm.cmpImm(VReg.S0, KEEP_N);
        vm.jge("_pgs_keep_done");
        vm.movImm(VReg.A0, KEEP_NODE);
        vm.call("_alloc");
        vm.store(VReg.RET, 0, VReg.S1); // node.next = head
        vm.addImm(VReg.V0, VReg.S0, 1);
        vm.store(VReg.RET, 8, VReg.V0); // node.tag = j+1
        vm.mov(VReg.S1, VReg.RET);      // head = node
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pgs_keep");
        vm.label("_pgs_keep_done");
        vm.lea(VReg.V0, "_gc_keep_head");
        vm.store(VReg.V0, 0, VReg.S1);

        // ---- M0 死垃圾(不保留 → 可回收)----
        vm.movImm(VReg.S0, 0);
        vm.label("_pgs_garb");
        vm.cmpImm(VReg.S0, M0_GARBAGE);
        vm.jge("_pgs_garb_done");
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pgs_garb");
        vm.label("_pgs_garb_done");

        // ---- 派发 N 个分配型任务到 P0 ----
        vm.movImm(VReg.S0, 0);
        vm.label("_pgs_spawn");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pgs_spawn_done");
        vm.lea(VReg.A0, "_m_alloc_task");
        vm.mov(VReg.A1, VReg.S0);
        vm.movImm(VReg.A2, 0);
        vm.call("_coroutine_create");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_scheduler_spawn"); // gomaxprocs>1 → _par_spawn → P0
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pgs_spawn");
        vm.label("_pgs_spawn_done");

        // ---- 预置 STW 请求旗:M1 起跑后在首个圈首停点(g0 栈,未跑任务)即 park,确定性 ----
        vm.lea(VReg.V0, "_stw_requested");
        vm.movImm(VReg.V1, 1);
        vm.stlr(VReg.V1, VReg.V0); // release
        // 起 N-1 个额外 M(各首个圈首停点即 park,确定性)
        vm.call("_m_start_extras");
        // gc_count before → S3
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.S3, VReg.V0, META_GC_COUNT);
        // 等全部额外 M park 达标(target = gomaxprocs-1;旗已预置 → begin 幂等重置旗 + 自旋等)
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.subImm(VReg.A0, VReg.A0, 1);
        vm.call("_stw_begin");
        vm.cmpImm(VReg.RET, 1);
        vm.jne("_pgs_after_gc"); // 超时(M1 未 park)→ 跳过收集(gc_smoke_ran 保持 0 → 后续判失败)
        // ---- 世界已停:真 GC(多 M 扩展根扫描在 _gc_collect 内经 _gc_scan_other_ms)----
        vm.call("_gc_collect");
        // gc_count 递增?→ 置 _gc_smoke_ran
        vm.lea(VReg.V0, "_heap_meta");
        vm.load(VReg.V1, VReg.V0, META_GC_COUNT);
        vm.cmp(VReg.V1, VReg.S3);
        vm.jle("_pgs_after_gc");
        vm.lea(VReg.V0, "_gc_smoke_ran");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_pgs_after_gc");
        vm.call("_stw_end"); // 清旗 + 唤醒 M1 续跑

        // ---- M0 亦排空 P0 + 窃取,再 join M1 ----
        vm.call("_par_sched_run");
        vm.call("_m_join_extras");

        // 复位 GOMAXPROCS=1
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);

        // ---- 校验① keeper 校验和(遍历活链表)== KEEP_SUM ----
        vm.lea(VReg.V0, "_gc_keep_head");
        vm.load(VReg.S1, VReg.V0, 0); // cur = head
        vm.movImm(VReg.S0, 0);        // sum
        vm.label("_pgs_ksum");
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_pgs_ksum_done");
        vm.load(VReg.V0, VReg.S1, 8); // tag
        vm.add(VReg.S0, VReg.S0, VReg.V0);
        vm.load(VReg.S1, VReg.S1, 0); // cur = cur.next
        vm.jmp("_pgs_ksum");
        vm.label("_pgs_ksum_done");
        vm.movImm(VReg.V0, KEEP_SUM);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jne("_pgs_fail");

        // ---- 校验② 任务结果 Σ == ALLOC_EXPECTED ----
        vm.movImm(VReg.S0, 0); // i
        vm.movImm(VReg.S1, 0); // sum
        vm.label("_pgs_tsum");
        vm.cmpImm(VReg.S0, SMOKE_N);
        vm.jge("_pgs_tsum_done");
        vm.lea(VReg.V0, "_par_alloc_results");
        vm.shlImm(VReg.V1, VReg.S0, 3);
        vm.add(VReg.V0, VReg.V0, VReg.V1);
        vm.load(VReg.V2, VReg.V0, 0);
        vm.add(VReg.S1, VReg.S1, VReg.V2);
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp("_pgs_tsum");
        vm.label("_pgs_tsum_done");
        vm.movImm(VReg.V0, ALLOC_EXPECTED);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jne("_pgs_fail");

        // ---- 校验③ 真跑了 GC(gc_count 递增)----
        vm.lea(VReg.V0, "_gc_smoke_ran");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 1);
        vm.jne("_pgs_fail");

        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label("_pgs_fail");
        vm.movImm(VReg.RET, -1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }
}
