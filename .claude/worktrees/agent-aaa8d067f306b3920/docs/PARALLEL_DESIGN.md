# 多核并行设计(G-M-P)— Phase 1 可行性研究

> 版本:初稿(设计阶段,零运行时代码改动)。
> 目标:以 **Go runtime 的真实实现原理**(共享堆 G-M-P 模型)为终态,给出 asm.js
> 单线程假设的全量清单、逐 OS 免 libc 线程创建评估、以及通往 G-M-P 的里程碑路线。
> 基线:本研究开始时 native macos-arm64 定点门 gen1==gen2==gen3 = `f2519054dbd1576560e9cb74f3c8ffdf`。

---

## 0. 术语对照(Go ↔ asm.js)

| Go | asm.js 现状 | 备注 |
|---|---|---|
| G(goroutine) | **已存在**:协程对象(runtime/async/coroutine.js;堆块,自带栈,`CORO_*` 槽位,`_coroutine_yield`/`_promise_await`) | async/await、生成器全骑其上 |
| M(OS 线程) | **不存在**(进程即唯一 M) | 本设计新增 |
| P(调度上下文) | 半存在:`_scheduler_*` + `_ev_*` 队列 = 唯一一份全局 P | 需结构化为 P struct × N |
| g0(M 的系统栈) | 主 native 栈(`_stack_base` 界定) | 每 M 一份 |
| mheap | bump 区(`_heap_meta`.base/used)+ 页映射(`_gc_pagemap_base`,1B/64KB 页) | 已有,单线程 |
| mcentral | `free_lists[18]` + span 切分逻辑 | 需加锁化 |
| mcache(per-P) | `_span_cur[18]`/`_span_end[18]`(全局唯一) | **天然 mcache 形态**,只差 per-P 化 |
| wbBuf(写屏障缓冲) | `_rs_base/_rs_top`(记忆集)+ `_box_reg_*`(box 登记) | 全局数组直接 append,需 per-P 缓冲 |
| sched(全局队列) | 无 | 新增 |
| safepoint | 无抢占;分配点已查 GC 触发;协程 yield/调用点是天然停点 | 对齐 Go <1.14(协作式) |
| channel | 无(里程碑 1 由另一 agent 在现协程引擎上实现) | 终态需 futex/ulock park-wake |

数据竞争立场 = **Go 的立场**:用户对象共享同一堆,channel 是同步原语;
对普通对象的竞争是程序员的责任(见 §5,asm.js 下竞争的后果比 Go 更重,必须写进用户文档)。

---

## 1. 单线程假设全量清单(核心交付)

### 1.1 采集方法

数据段可变槽全部经 `asm.addDataLabel()` 注册。静态注册点:
`runtime/core/allocator.js:generateDataSection`(主体)、`runtime/async/coroutine.js:999-1013`、
`runtime/core/process.js:887-916`、`runtime/types/symbol/index.js:44-51`、
`runtime/types/object/index.js:131`、`runtime/core/strings.js:114`、`compiler/index.js:2650`。
动态族(codegen 逐站点发射):`compiler/expressions/members.js:114,133`(IC 站点)、
`compiler/expressions/expressions.js:811,825`(`_tmplsite_*`/`_funcproto_*`/`_funcclosure_*`)、
`compiler/functions/statements.js:352,2345,2676,2770`(builtin/classinfo/superinfo)、
`compiler/functions/functions.js:1471`、`compiler/index.js:1784`(`_main_captured_*`)。

统计:**静态命名标签 71 个**(其中 `_heap_meta` 是 256B 块,内含 base/size/used/gc_running/
free_lists[18]/large_free/gc_count/alloc_count/peak ≈ 25 个活跃标量槽,合计 **≈96 个标量槽**;
`_span_cur`/`_span_end`/`_gc_spanusable` 各展开 18 槽)+ **7 个动态族**(数量随程序规模,千级)。

GC 根扫描区 = `[_data_start, _data_gc_end)`,跳过 `[_heap_meta, _heap_meta_end)`
(allocator.js:3006-3062)。凡落在跳过区内的槽 GC 不当根;落在扫描区内的槽兼任 GC 根。

### 1.2 分类表(以 G-M-P 终态为准)

分类五档:**RO**(init 后只读)/ **per-M**(线程本地,TLS)/ **per-P**(调度上下文本地)/
**LOCK**(共享互斥)/ **GC-only**(仅 STW 期间 GC 协调者触碰,天然安全)/
**ATOMIC**(原子发布或良性竞争)。

#### A. 堆/分配器(`_heap_meta` 跳过区内)

| 槽 | 现职责 | 终态分类 | 备注 |
|---|---|---|---|
| meta.heap_base / `_heap_base` | 堆基址 | RO | mmap 一次 |
| meta.heap_size | 堆总大小 | RO(增长时 LOCK) | |
| meta.heap_used / `_heap_ptr` | **bump 游标(分配最热字)** | LOCK(mcentral)→ 热路走 per-P mcache | Go: mheap.lock |
| meta.gc_running | GC 进行中旗 | ATOMIC | STW 协调旗 |
| meta.free_lists[18] | size-class 空闲链头 | **LOCK = mcentral** | sweep 归还/mcache 取 span 两处入锁 |
| meta.large_free | 大对象链 | LOCK | |
| meta.gc_count/alloc_count/peak | 统计 | per-P 累加,STW 汇总 | |
| `_span_cur[18]` / `_span_end[18]` | 每 class span bump 游标 | **per-P = mcache** | 本设计最核心的一次搬迁;快路零锁 |
| `_gc_spanusable[18]`、`_gc_s2c`、`_gc_c2s` | 编译期常量表 | RO | 不动 |
| `_gc_pagemap_base` | 页映射基址 | 指针 RO;页表内容写 = LOCK(随 span 切分) | 读(is_heap_ptr/块定位)无锁:1B 写原子 |

#### B. GC 机器(跳过区内)

| 槽 | 现职责 | 终态分类 |
|---|---|---|
| `_gc_mstack_base/top/cap`、`_gc_overflow` | 显式标记栈 | GC-only(STW 单协调者;远期并行 mark 再分片) |
| `_gc_bitmap_base`、`_gc_startmap_base`、`_rs_dedup_base`、`_shadow_base/_shadow_miss` | 位图基址(RO 指针)+ GC 期写 | 指针 RO;内容 GC-only |
| `_gc_live_bytes`、`_gc_regsave`、`_gc_val_count`、`_gc_dbg_buf`、`_gc_diag_*`、`_alloc_dbg_*` | sweep 统计/寄存器暂存/诊断 | GC-only(`_gc_regsave` 改 per-M:各 M 停点自 spill) |
| `_gc_alloc_since`、`_gc_since_full` | 分配步调计数(**分配热路每次加**) | per-P 计数,越阈值原子汇总触发 |
| `_gc_trigger`、`_gc_full_trigger` | 触发阈值 | RO between GCs(仅 STW 内更新) |
| `_gc_last_ptr` | young 代起点 | RO between GCs |
| `_box_reg_base/top` | box 登记表(装箱写屏障 append) | **per-P 缓冲 + STW 合并**(Go wbBuf 模式) |
| `_rs_base/top/overflow` | 分代记忆集 append | 同上 per-P 缓冲 |

#### C. 调度器/事件循环(= 未来 P struct 的雏形)

| 槽 | 现职责 | 终态分类 |
|---|---|---|
| `_scheduler_ready_head/tail` | 协程就绪队列 | **per-P 本地 runq**(+ 新增全局队列 + 窃取) |
| `_scheduler_current` | 当前运行协程(**GC 推迟判据**,allocator.js:742) | per-M(严格随执行线程) |
| `_scheduler_main` | 主协程指针 | per-M(每 M 的 g0 语义) |
| `_ev_micro/imm/timeout_head/tail`(6 槽)、`_promise_micro_head/tail` | 微任务/immediate/timer 队列 | per-P |
| `_gen_last_coro` | 生成器 stub 回填 scratch | per-M |

#### D. 线程执行状态(必须 per-M,第二个 M 起跑前的硬前提)

| 槽 | 现职责 | 终态分类 | 竞争后果(若不迁) |
|---|---|---|---|
| `_call_argc` | **每个 JS 调用点 call 前写、被调方 prologue 读**的实参数 ABI 槽 | **per-M** | 另一 M 在写-读窗口内覆盖 → arguments/Proxy 蹦床实参数错乱。最热的一个槽 |
| `_exception_pending/_exception_value` | 跨函数异常传播旗/值 | per-M | 异常串线程 |
| `_exc_ctx_top` | try 帧链头(帧在栈上) | per-M | unwind 进别人的栈 |
| `_stack_base` | 主栈根扫描上界(_start 记录) | per-M(M struct 字段) | 栈扫描越界崩 |
| ~~`_call_stack/_call_stack_top`~~ | ~~Error 栈踪影子栈~~ | **死代码,删** | 见 §M2 步骤 7 发现:`ErrorGenerator` 从未实例化,活错误路径用普通对象,无影子栈 |
| `_parse_lenient` | parseFloat 宽松旗(调用前置 1 后清 0) | per-M(更优:改传参消灭之) | Number() 偶发宽松 |
| `_print_buf` | 打印格式化缓冲 | per-M + stdout 写 LOCK | 输出撕裂 |

#### E. 共享注册表(LOCK)

| 槽 | 现职责 | 终态分类 |
|---|---|---|
| `_symbol_registry` | Symbol.for 全局表 | LOCK(低频) |
| `_closure_props_registry` | 闭包/函数属性侧表(裸指针键) | **LOCK,且是难点**:用户往函数上挂属性即写它,频率不可控;远期把侧表并进闭包对象消灭全局表 |
| `_module_registry` | 模块注册表 | 启动期写完 → RO;L2 引擎库(eval/动态 import)引入运行期写 → LOCK |

#### F. init 后只读(不动)

`_js_true/_js_false/_js_null/_js_undefined`(装箱单例)、`_global_this`、`_process_global`、
`_symwk_*`(well-known symbols,init 一次)、`_win_argv_ptr`、各 cstring、`_data_gc_end`(哨兵)。
注意:`_global_this`/`_process_global` **指针** RO,但所指对象是用户可变共享对象 → 归 §5 用户竞争范畴。

#### G. codegen 动态族(千级,逐站点)

| 族 | 语义 | 终态分类 |
|---|---|---|
| `icg_site_*` / `ics_site_*` | 属性读写站点缓存(icg 已 16B 化 {cached_shape, cached_index},形状 IC A2;ics 仍 8B 下标槽) | **ATOMIC-良性竞争**:8B 对齐读写天然原子;16B 双字段可被竞争撕裂(新形状+旧下标),但**键自验证单 cmp 兜底**——撕裂对必验证失败走慢路重学习,无错值。Go 风格保留全局,零改动。**注意:A3 若消除键自验证,须先解决撕裂对(release/acquire 配对或并行下保留 cmp),重审此行** |
| `_tmplsite_*` | tagged template 模板对象站点 memo | ATOMIC 发布(CAS 或 last-writer-wins)。竞争双初始化 → 模板对象站点恒同性被打破(规范可见);低危,文档化或 CAS |
| `_funcclosure_*` / `_funcproto_*` | 声明函数闭包/原型 memo(f===f 身份) | 同上:CAS 发布,保身份稳定 |
| `_classinfo_*`/superinfo/builtin 闭包槽 | 类元数据/内置闭包 memo | 同上 init-once ATOMIC |
| `_main_captured_*`、模块级变量槽 | **用户可见 JS 全局/模块变量** | 保持共享(Go 语义);对齐 qword 读写不撕裂即可 |

### 1.3 分类汇总

- **RO / init 后只读**:约 24 槽(+全部常量表、cstring)— 零成本。
- **per-M(TLS)**:约 12 槽 — 第二个 M 运行任何 JS 前的**硬前提**(D 组全体 + `_scheduler_current/_main`、`_gen_last_coro`、`_gc_regsave`)。
- **per-P**:约 50 槽(span 游标 36 + 调度/事件队列 10 + 步调计数/屏障缓冲)。
- **LOCK**:约 8 处(mcentral 的 free_lists/large_free/bump 增长/页表写 + 三注册表 + stdout)。
- **GC-only(STW 内天然安全)**:约 15 槽。
- **ATOMIC/良性竞争**:IC 站点 + 5 个 memo 族(动态,千级,**代码零改或仅换 CAS 发布**)。
- **用户可见共享**(竞争=程序员责任):模块变量槽、`_main_captured_*`、globalThis/process 对象图。

### 1.4 协程栈与 GC 的关键机制(实测确认)

- 协程栈是**堆块**(coro+16 存 stack_base),经保守链 `genobj/promise→coro→栈块` 整块标记,
  挂起协程的活值不漏根(allocator.js:736-740 注释)。→ 挂起 G 的扫描**免费**,多 M 化不变。
- **GC 在协程栈上执行时被推迟**:根扫描只认 `[SP, _stack_base)`,SP 落在堆内时区间非法,
  故 `_alloc` 查 `_scheduler_current` 非主协程即跳过触发,推迟到回主栈后的下一次分配
  (alloc_since 不清零)。→ **多 M 下这是死结**:N 个 M 几乎总有人在协程栈上,STW 永远等不齐。
  必须改为:协程切换时在 M struct 记录**当前栈区间** `[cur_stack_lo, cur_stack_hi)`
  (主栈或 coro 栈块界),根扫描按 M 记录的区间扫 — 顺带消灭"协程栈上推迟 GC"这个
  单线程时代的补丁。这是 GC 侧改造的第一刀,也是最险的一刀(碰协程引擎,见 §7 风险)。

---

## 2. 免 libc 的 OS 线程创建(逐目标评估)

asm.js 全部 syscall 裸发(svc/syscall,无 libc),线程创建同路数。

### 2.1 linux-arm64 / linux-x64 — 首选,ABI 公开稳定

- **clone**:x64 №56 / arm64 №220。旗标(pthread 等价):
  `CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS|CLONE_CHILD_CLEARTID`
  = `0x100|0x200|0x400|0x800|0x10000|0x40000|0x80000|0x200000 = 0x2D0F00`。
- **子栈**:独立 mmap(如 8MB,`MAP_PRIVATE|MAP_ANON`),SP=区顶(16 对齐);裸 clone 子线程以
  x0/rax=0、SP=child_stack 返回,跳线程入口蹦床(蹦床读 M struct 指针 → 设 TLS → 进调度循环)。
- **TLS**:arm64 `CLONE_SETTLS` 直设子线程 TPIDR_EL0(EL0 可 `mrs/msr` 自由读写,主线程 msr 即可);
  x64 主线程 `arch_prctl(ARCH_SET_FS)`(№158),子线程经 CLONE_SETTLS。
- **join/park**:`futex`(x64 №202 / arm64 №98)`FUTEX_WAIT/FUTEX_WAKE`;
  `CLONE_CHILD_CLEARTID` + futex-wait 该字 = 标准 join。
- **线程退出**:`exit`(x64 №60 / arm64 №93,非 exit_group)。
- 评估:**零私有 ABI,风险最低,里程碑 c 在此起步。**

### 2.2 macOS(arm64 / x64)— 可行但私有 ABI,如实标注脆弱

- 路 A:`bsdthread_register`(№366,进程一次,注册线程启动蹦床)+ `bsdthread_create`(№360)
  + `bsdthread_terminate`(№361)。**pthread-kext 私有 ABI**:签名/旗标随大版本漂移
  (Go 正因此在 1.11 放弃 darwin 裸 syscall 全面转 libSystem)。asm.js 既有 syscall
  (mmap/write/exit)是稳定 BSD 号,bsdthread_* 的漂移风险高一档。
- 路 B:Mach traps(`thread_create` + `thread_set_state`)— 同为私有但历史上更稳;
  产出的线程无 pthread TSD/无注册栈,任何隐性依赖 pthread 结构的内核路径(某些信号/
  workq 交互)行为未定义。asm.js 不用 libc,TSD 缺失本身无害。
- 路 C(回避):macOS 不做线程,先以进程 worker(fork/posix_spawn + pipe/shm)提供多核 —
  **与 G-M-P 终态相悖,仅作 ABI 断裂时的逃生舱记录,不排里程碑。**
- TLS:arm64 **不依赖 OS TLS,保留 x28 作 P/M 寄存器**(见 §3.1,darwin arm64 的
  TPIDR_EL0 用户态可用性存疑,TPIDRRO_EL0 归 libpthread,一律不碰);
  x64 经 machdep trap `thread_fast_set_cthread_self`(№0x3000003)设 GS base。
- park/wake:`__ulock_wait`(№515)/`__ulock_wake`(№516)— libplatform 私有,但
  os_unfair_lock 全系统在用,漂移概率低于 bsdthread_*。
- **结论:Linux-first;macOS 里程碑后置,落地时附一个版本探针冒烟测试
  (bsdthread_register 失败 → 明确报"该 macOS 版本线程 ABI 未适配"降级单 M),
  与"arm64 自举冻结"约束叠加 → macOS 改动必须绝对增量。**

### 2.3 windows-x64 — 机械可行

PE 后端已有 kernel32 IAT 机制(binary/pe.js,现仅 VirtualAlloc/GetStdHandle/WriteConsoleA/
ExitProcess + winfs 若干,槽位追加是既有模式)。追加 `CreateThread`/`WaitForSingleObject`/
`WakeByAddressSingle`+`WaitOnAddress`(api-ms-win-core-synch-l1-2-0)或退而 Event 系。
TLS:GS 天然指 TEB,`TlsAlloc` 后用 `gs:[0x1480 + idx*8]`(TlsSlots)。风险低,排 linux 之后。

### 2.4 wasm32 — 明确出圈

wasm threads 提案 + SharedArrayBuffer + atomics,与 native 代码发射路径完全不同层;
本设计不覆盖,wasm 目标维持单线程语义。

---

## 3. P/M 上下文的寄存器与 TLS 设计

### 3.1 arm64:保留 x28 作 P 寄存器(推荐,与 Go 同构)

后端 regMap(backend/arm64.js:50-82)只用 x0-x5、x8-x15、x19-x24、fp/sp/lr:
**x25-x28 全空闲**。保留 **x28 = 当前 P/M 上下文指针**(Go 在 arm64 用 x28 存 g,同位):

- `str x9, [x28, #OFF_CALL_ARGC]` — per-M 槽访问与今日 `adrp+add+str` 相比**更短更快**。
- 不依赖任何 OS TLS 设施,darwin/linux 同一形态;线程入口蹦床一条 `mov x28, x0` 完成绑定。
- 代价:向量场景无(x28 非现役);唯一约束是今后寄存器分配器永不碰 x28。

### 3.2 x64:无空闲 GPR → 段寄存器 TLS

regMap(backend/x64.js:39-78)16 个 GPR 全占(S5 已被迫落栈槽)。P 上下文走段基址:

- linux:FS(arch_prctl 设);macOS:GS(machdep trap);windows:GS→TEB TlsSlot。
- 访问形态 `mov rax, fs:[OFF]`(linux)— 每 per-M/per-P 槽一条带段前缀的 mov,成本与
  绝对地址 mov 相当。三 OS 三种设基方式,由 `vm.loadTls/storeTls` 抽象,后端各自落段前缀。
- 备选(否决记录):腾出 R15 作 P 寄存器 — 会重排 S1-S4 全部分配,踩
  "S寄存器恢复依赖"与产物膨胀雷区,不值。

### 3.3 vm 层抽象

新增 `vm.tlsLoad(dst, OFF)` / `vm.tlsStore(OFF, src)` / `vm.tlsLea(dst, OFF)`;
arm64 → `[x28+OFF]`,x64 → 段前缀。M struct 与 P struct 布局(草案):

```
M struct(per OS 线程,mmap 一块):
  +0   self / OS tid          +8   cur_stack_lo(当前执行栈下界=扫描起点候选)
  +16  cur_stack_hi(上界:主栈=stack_base,coro 栈=栈块顶)
  +24  scheduler_current      +32  scheduler_main(本 M 的 g0)
  +40  call_argc              +48  exception_pending
  +56  exception_value        +64  exc_ctx_top
  +72  call_stack_top / +80 call_stack[]  指针
  +88  parse_lenient          +96  print_buf 指针
  +104 gen_last_coro          +112 gc_regsave[]/safepoint 状态
  +...  attached P 指针
P struct:
  runq(局部双端队列,head/tail/环形数组)、ev_* 三队列、promise_micro 队列、
  mcache:span_cur[18]/span_end[18]、gc_alloc_since、wb 缓冲(rs/box)cur/end、统计
```

---

## 4. 里程碑路线(直奔 G-M-P,不绕隔离堆)

> 每个里程碑单独过定点门;产物字节大改的里程碑(M2)按波次拆分,
> 每波跑门(见"自编译布局位置敏感的定点振荡"教训:非尺寸单调,必须实测)。

### M1 — `go` 语句 + Channel,GOMAXPROCS=1(已指派另一 agent;本设计的前向兼容约束)

单 P 单 M,`go fn(args)` = 建协程入就绪队列(现 `_scheduler_ready_*`),channel 的
park/unpark 骑协程 yield。**本设计要求 M1 遵守**:
(a) channel 阻塞语义走"挂起 G + 入等待队列",不自旋不忙等 — 终态只需把"唤醒"从
"入本地就绪队列"换成"入目标 P 队列 + futex 唤醒空闲 M";
(b) channel 对象布局预留 lock 字(qword,M1 恒 0)与等待队列头,避免终态改布局;
(c) API 定型:`go(fn, ...args)`、`chan(cap)`、`ch.send(v)`(满则挂起)、
`await ch.recv()`(空则挂起)、`ch.close()`。与 worker_threads 的差异(无序列化、
共享堆、按引用传递)在用户文档言明。
工作量:1-2 周(他人)。多核价值:0(但定义了全部用户语义)。

### M2 — P/M 上下文化 + 全局槽 TLS 化(§1 清单的执行)

> **状态(进行中,2026-07-16)**:
> - **步骤 1 已落地**:arm64 保留 **x28** 作 P/M 上下文寄存器;新增静态 per-M 块
>   `_m0_context`(§3.3 布局,`runtime/core/allocator.js` 的 `MCTX_*` 常量,256B,置于 GC
>   根扫描区);`_start` 于最前 `mov x28, &_m0_context` 绑定(`vm.bindMContext` →
>   `backend/arm64.js:bindContextReg`);x64/wasm 后端 no-op(§3.2 段 TLS 后续)。尚无槽读 x28。
>   门:gen1==gen2==gen3 字节一致(g1 无 segfault,15MB);fixtures 292 PASS;M1
>   spawn/channel 经自举产物验证输出恒等。
> - **步骤 2 已落地**:§1.2 D 组第一类 per-M 槽 `_exception_pending`/`_exception_value`
>   经 x28 重定向寻址。`backend/arm64.js` 的 `M_CTX_REDIRECT` 表把对这两个标签的 `lea`
>   改发 `add xd, x28, #OFF`(OFF=MCTX_EXC_PENDING/VALUE=48/56),覆盖全部 AOT 站点与
>   L2 引擎 `_engine_symaddr` 表(同走 `vm.lea`)→ 一致寻址 `_m0_context` 内槽。x64/wasm
>   不重定向,`process.js` 仍声明扁平标签供其使用(段 TLS 后续)。异常机器是编译器自身
>   自举依赖的最热路径之一;门:gen1==gen2==gen3 字节一致,fixtures 292 PASS,
>   try/catch/finally + async reject + `js` spawn-panic(经协程异常链)自举产物输出恒等。
> - **步骤 3 已落地**:`_exc_ctx_top`(try 帧链头,MCTX_EXC_CTX_TOP=64)并入
>   `M_CTX_REDIRECT` → 异常/展开机器全套 per-M 完成。门:gen1==gen2==gen3,fixtures
>   292 PASS,多帧 try/finally/catch 重抛展开 + spawn-channel/panic 自举产物验证。
> - **步骤 4 已落地**:`_call_argc`(**§1.2 最热 ABI 槽**,每调用点写、被调 prologue 读,
>   MCTX_CALL_ARGC=40)并入重定向。实测结果反直觉地干净:lea(adrp+add,2 指令)→
>   add(1 指令)在数千调用点净缩 __text **~164KB**(15.19MB→15.02MB),布局悬崖**未触发**,
>   gen1==gen2==gen3 字节一致、g1 无 segfault。fixtures 292 PASS;arguments.length/变参/
>   Proxy apply+construct 蹦床/嵌套 arguments 转发 自举产物与 Node 逐行相等;
>   spawn-channel/panic 恒等。→ arm64 x28 寻址"净赢或持平"的设计判断在最热槽上被证实。
> - **步骤 5 已落地**:`_gen_last_coro`(生成器 stub 回填 scratch,裸协程指针,
>   MCTX_GEN_LAST_CORO=104)干净一行重定向。全部访问经 `vm.lea`(`runtime/async/coroutine.js`
>   写、`compiler/async/async.js` 读)→ 自动改发 `add x28,#104`。槽在 `_m0_context` GC 根
>   扫描区内 → 挂起生成器协程指针仍当根,不漏标。门:gen1==gen2==gen3 字节一致、g1 无
>   segfault;fixtures PASS;generator/async-generator + spawn 经协程链自举产物恒等。
> - **步骤 6 已落地**:`_parse_lenient`(parseFloat 宽松解析旗,标量,MCTX_PARSE_LENIENT=88)
>   干净一行重定向。全部访问经 `vm.lea`(`runtime/core/coercion.js` 置 1/清 0/读)→ 自动
>   改发 `add x28,#88`;x64/wasm 保留扁平标签。门:gen1==gen2==gen3 字节一致、g1 无
>   segfault;fixtures PASS;parseFloat/Number() 严格vs宽松尾缀(`"3.14px"`→3.14 vs NaN)
>   自举产物与 Node 一致。
> - **步骤 7 已落地**:`_print_buf`(打印格式化缓冲)**指针化 + 重定向**。由内联缓冲拆为
>   **8B 指针槽**(重定向 MCTX_PRINT_BUF=96)+ 静态缓冲 `_print_buf_storage`(M0,`runtime/core/
>   strings.js`)。`_start` 在 x28 绑定后把 `_print_buf_storage` 地址写入指针槽(全平台一致寻址,
>   静态缓冲无需堆 → 先于 `_heap_init`)。五处消费站点(`_print_int`/`_print_int_no_nl`/`_print_hex`,
>   `runtime/types/number/print.js`)在 lea 后各加一次解引用 load。整数打印是热路(compiler/index.js
>   :1597 及 core/print.js 多处经 `_print_int`),故这是首个**热路上**的指针化槽,+1 load/整数打印。
>   门:gen1==gen2==gen3 字节一致、g1 无 segfault;fixtures PASS;整数/负数/十六进制打印自举产物
>   与 Node 逐字节相等。→ 修订 §3.3「内联缓冲须先指针化」结论兑现(唯一真·活槽 `_print_buf`)。
> - **实现发现(修订 §1.2 D 组 + §3.3):`_call_stack*` 是死代码,非活槽。** `_call_stack`/
>   `_call_stack_top` 及整个 Error 影子调用栈(`_stack_push`/`_stack_pop`/`_stack_capture`/
>   `_error_new`)只存在于 `runtime/types/error/index.js`,而该文件的 `ErrorGenerator` **从未被
>   `runtime/index.js` 的 `RuntimeGenerator` 实例化**(全仓无 import)——经典 asm.js 死代码陷阱。
>   活的错误路径把 `new TypeError(msg)` 等编译为**普通对象** `{name,message,__asmjs_err}`
>   (`compiler/functions/statements.js:emitThrowTypeError`),不经影子栈、无 `.stack` 捕获。
>   故 `_call_stack*` **无需 per-M 化**(无活槽可竞争);§1.2 D 组该行应删。曾尝试指针化时,
>   在 `_start`(活代码)加对死标签 `_call_stack_buf` 的 lea → 链接期 `Unknown label`,已回退。
>   → D 组真·活执行态槽收敛为:`_call_argc`/`_exception_*`/`_exc_ctx_top`/`_parse_lenient`/
>   `_print_buf`(**均已 per-M 化**)+ `_stack_base`(§1.4 M5 栈扫描一并处理)。
> - **步骤 8 已落地(M3 前置)**:C 组 `_scheduler_current`(MCTX_SCHED_CURRENT=24)+
>   `_scheduler_main`(MCTX_SCHED_MAIN=32)并入 `M_CTX_REDIRECT`。这是**第二个 M 并发
>   resume 协程的硬前提**:`_coroutine_resume/entry/yield/return` 全经此二槽做栈切换与
>   resumer 链管理,全局共享则两 M 互踩。全部访问经 `vm.lea`(coroutine.js/allocator.js
>   GC 推迟判据/process.js 事件循环/promise.js/async.js)→ 一致改发 `add x28,#24|#32`。
>   `_scheduler_current` 兼任 GC 推迟判据,但 M>1 的 GC 安全属 M4/M5,本轮冒烟任务**不分配**
>   以规避;GOMAXPROCS=1 下 x28=_m0_context,行为与旧全局槽逐字节等价。门:macos-arm64
>   gen1==gen2==gen3 字节一致(30eab153…)、g1 无 segfault;fixtures 322 PASS;M1
>   spawn/channel/panic 恒等;linux-arm64 bringup 冒烟 "second M joined" 经 Docker 通过。
> - 待办:`_gen_last_coro` 已迁(步骤 5)。x64/wasm 的段寄存器 TLS(§3.2)整体后置。
>
> **实现发现(修订 §3.3 布局假设)**:`M_CTX_REDIRECT` 只能重定向**标量/指针槽**
> (lea → `add x28,#off`,槽 ≤8B)。原判两个 D 组槽是**内联缓冲区**须先指针化:
> `_call_stack`=64×8=**512B 内联数组**、`_print_buf`=**24B 内联缓冲**。直接重定向会让写越出
> 256B 的 M struct、踩其它槽。**结论修正(步骤 7)**:`_print_buf`(`runtime/core/strings.js`,活)
> 已按此法指针化——8B 指针槽入 M struct + 静态缓冲 `_print_buf_storage` + `_start` 填址 + 消费
> 站点解引用;而 `_call_stack`(`runtime/types/error/index.js`)经查为**死代码**(见下方步骤 7
> 发现),无需处理。`_gen_last_coro`(指针)、`_parse_lenient`(标量)是干净的一行重定向。
> 指针化模式(指针槽 + 静态存储 + _start 填址 + 站点解引用)同样适用 x64 段 TLS 与 M3 各 M 起跑。

1. 落 §3 的 x28 / 段 TLS 与 M/P struct;单 M 下先让主线程也经由 M struct 跑(行为等价)。
2. 迁移波次(每波过门):D 组 per-M(12 槽,`_call_argc` 打头)→ C 组 per-P(调度/队列)
   → 步调计数与 wb 缓冲 per-P → memo 族换 CAS 发布。
3. mcentral 锁与 stdout 锁落地但单 M 下恒无争(自旋锁一条 CAS,linux 先行)。
工作量:**3-6 周,全项目最大焦土**(每个 `lea(global)` 变 TLS 寻址 → 产物全量字节漂移;
arm64 是净赢或持平,x64 段前缀持平)。风险:定点门 + 五大支柱基准回归(须实测热基准,
S 寄存器/布局教训)。多核价值:0,但完成后运行时理论上可重入。

### M3 — M 创建 + G-M-P 调度环 + 窃取(linux 先行)

> **状态(prep 已落地,2026-07-16)**:
> - 裸 clone()/futex/join 原语(`runtime/core/thread.js`,commit e1b735c2)已验证。
> - **第二个 M 起跑管线已接线**(`runtime/core/m_bringup.js`,新增叶子生成器,不碰热路):
>   `_m_thread_entry(m_ctx)` = **线程入口蹦床**(`bindMContext` 把 x28 绑到第二个 M 的
>   上下文块 → `_scheduler_run` 进调度环 → 返回后 `_thread_create_raw` 子路径 sys_exit);
>   `_m_bringup_second()` = mmap 第二个 M 的上下文块(一页,前 256B=M struct,+512 起 = 该 M
>   私有打印缓冲,初始化其 `MCTX_PRINT_BUF` 指针)+ 经 `_thread_create_raw` 起线程,**受
>   `_gomaxprocs` 门控**(默认 1 → 直接返 -1,不起线程)。仅 linux-arm64/x64 真体,其余桩。
> - **GOMAXPROCS 门(`_gomaxprocs`,默认 1)**:编译产物内无路径改写它(process.env 恒空)
>   → 单 M 定点默认零触达起跑代码;起跑函数在默认下永不被调用(纯附加死码)。
> - 冒烟探针 `__m_bringup_smoke`(shim 层内建,`compiler/functions/functions.js`,非用户 API)
>   临时开门 GOMAXPROCS=2 → 起第二个 M → join → 复位;测试件 `tests/parallel/m_bringup_smoke.js`。
> - 门:**GOMAXPROCS=1 定点未破** —— macos-arm64 gen1==gen2==gen3 字节一致、g1 无 segfault、
>   fixtures ≥309、M1 spawn/channel 恒等(附加代码不改默认路径,仅 __text 尺寸增)。
> - **仍属后续里程碑**:真正的多 M 调度(per-P runq/窃取/park-unpark)、M>1 下的分配/GC
>   安全(M4/M5)。本 prep 只把"第二个 M 能起跑并绑定自己的 x28 上下文"这一步管线打通。
>   已知局限:第二个 M 现仍共享全局 `_scheduler_ready_*`(冒烟下 M0 不调度 → 队列空即返回);
>   x64 `bindMContext` 是 no-op(段 TLS 后置)→ x64 起跑路径暂未真正隔离 per-M 槽。

> - **步骤 9 已落地(并行底盘,`runtime/core/parallel_sched.js`,linux-arm64 真体/其余桩)**:
>   ① 原子 RMW 原语(LL/SC:`ldaxr`/`stlxr`/`clrex`/`stlr`,asm+backend+vm 三层;x64/wasm
>   显式 throw 桩,段 TLS 多 M 后置);② 自旋锁 `_spin_lock`/`_spin_unlock`(acquire/release);
>   ③ **per-P 运行队列**(`_p_array`,P_MAX=2,每 P = 锁 + 环形 deque[256]),`_p_runq_push`/
>   `_p_runq_pop`(**窃取 = 对他人 P 调 pop**,同锁天然安全,免死锁);④ **全局队列**
>   `_global_runq_*`(加锁链表,复用协程 +80 next);⑤ 可运行 G 原子计数 `_global_runnable`
>   = 终止判据 + futex 睡眠字;⑥ `_par_spawn`(计数+1、入当前 M 的 P、futex 唤醒空闲 M)、
>   `_par_sched_run`(本地→全局→窃取→计数 0 退出/否则 futex 睡的 Go 式调度环)。当前 M 的 P
>   经 `_m_current_p`(重定向 x28+MCTX_P=112)取。**纯附加,无既有路径改写** → 门:macos-arm64
>   gen1==gen2==gen3 字节一致(eab0b06d…)、fixtures 322 PASS、linux-arm64 编译通过。
>   队列 label 名避 `_global_` 前缀(用 `_grq_*`/`_grunnable`):**asm/arm64.js 把 `_global_` 前缀
>   label 一律当数据段**(fixup 走 dataVAddr)→ 若函数名以 `_global_` 起头,BL 会解析成数据地址
>   跳进数据段崩;实测踩坑已记(定位:BL 目标错→段错)。
> - **步骤 10 已落地(接线 + 端到端验证,linux-arm64 经 Docker 实跑)**:
>   ① `_scheduler_spawn` 加 `_gomaxprocs>1` 分支路由到 `_par_spawn`(**step 2:`js f(x)` spawn 入
>   P runq**);默认 GOMAXPROCS=1 走既有全局链表串行路径,逐字节不变。② `_m_bringup_second`
>   在 M0 侧预置第二个 M 的上下文:`MCTX_P=&_p_array[1]`、g0 协程块(ctx+1024,type/status;
>   作 `_coroutine_resume` 的 resumer 根,**免第二个 M 分配**)、`MCTX_SCHED_CURRENT/MAIN=g0`;
>   `_m_thread_entry` 改进 `_par_sched_run`(而非 `_scheduler_run`)。③ 冒烟探针 `__par_smoke`
>   (shim 内建 `compiler/functions/functions.js`):开门 GOMAXPROCS=2 + 禁 GC(阈值→∞)→ 建 16 个
>   run-to-completion 任务协程经 `_scheduler_spawn` 派发到 P0 → 起第二个 M 跑 `_par_sched_run`、M0
>   亦跑 → 两 M 经 per-P runq + **工作窃取** 排空 → join → 校验 Σ(results[i]=i+1)==136 → 复位。
>   **验证(linux-arm64,Docker qemu,×8 稳定)**:`m-sched: 16 tasks across 2 Ms, sum=136 ok / PASS`
>   —— 16 个协程跨 **2 个真实 OS 线程** 由 per-P runq+窃取分派、run-to-completion、确定性求和。
>   门:macos-arm64 gen1==gen2==gen3 字节一致(eac3dea8…)、g1 无 segfault、fixtures 322 PASS、
>   M1 spawn/channel/panic 恒等、bringup 冒烟仍 "second M joined"。
> - **M3 达成的真实多核**:linux-arm64 上无 GC 纯计算负载首次跨 2 M 并行执行(§4-M3 目标兑现)。
>   **仍属 M4/M5**:第二个 M 上的分配安全(mcache 竞争,本轮以"任务不分配 + 禁 GC"规避)、
>   STW GC + 协程栈扫描;**M6**:channel 跨 M 唤醒(本轮任务不 yield/await)。x64 多 M 待段 TLS(§3.2)。
>
- clone/futex(§2.1)、线程入口蹦床、M park/unpark(空闲 M 睡 futex)。
- 调度环(Go 算法):本地 runq(环形 256,无锁单生产者)→ 61 次一查全局队列 → 偷别人
  一半(随机起点遍历 P)→ netpoller 无(asm.js 无异步 IO,跳过)→ park。
- GOMAXPROCS = 环境变量/API,P 数组静态分配。
- **过渡期分配安全**:mcache 未 per-P 前,`_alloc` 全程一把自旋锁(正确但争用)—
  或直接与 M4 合并交付。**GC 过渡期策略:M>1 时 GC 触发即 panic-report(诊断模式)或
  阈值调至无穷 + 文档警告**,直到 M5;短程 CPU-bound 负载已可先测加速比。
工作量:2-4 周。多核价值:**首次真实多核加速**(无 GC、纯计算负载)。

### M4 — per-P mcache 无锁分配 + 加锁 mcentral

> **状态(mcache 路径 + GC-off 已落地,2026-07-16)**:交付**部分 M4 = per-P mcache 无锁小对象
> bump + 锁保护 refill,GC 全程禁用(GOMAXPROCS>1)**。完整 STW GC 属 M5,本轮以"GC-off +
> 任务只碰自身 young 对象"规避(见下"多 M 分配安全边界")。
> - **per-P mcache(`runtime/core/parallel_sched.js`)**:P struct 尾部新增 `mc_cur[18]`/
>   `mc_end[18]`(`P_MC_CUR=2080`/`P_MC_END=2224`,`P_SIZE` 2080→**2368**;`m_bringup.js`
>   从此单一真源 import `P_SIZE`,第二个 M 的 P=&_p_array[1] 随之正确)。新增全局
>   `_mheap_lock`(序列化全局堆游标推进)。
> - **`_alloc` 分配快路(`runtime/core/allocator.js`,全部 `if(isParallel)` 门,isParallel =
>   linux-arm64)**:①`_alloc_small_bump` 处插 `_gomaxprocs>1` 门 → `_alloc_small_mm`:读
>   **当前 M 的 P**(`_m_current_p`→x28+MCTX_P)的 `mc_cur[class]`,span 内 bump **零锁**;
>   耗尽/空 → `_mcache_refill`。复用既有共享尾 `_alloc_span_hdr`(尾哨兵+块头+startmap)。
>   ②`_mcache_refill(class,stride)`:持 `_mheap_lock`,`_bump_alloc` 预留 2×64KB→向上取整到
>   64KB 边界得整段 span→设 P.mc_cur=base+stride/mc_end=base+usable→返回首块(锁内游标推进独占)。
>   ③`_alloc_large_bump` 在 `_gomaxprocs>1` 时同锁串行(大对象直取全局游标)。
> - **HARD INVARIANT 守住**:上述分支**仅 linux-arm64 发射**;macos-arm64 自举门产物内 `_alloc`
>   **逐字节不变**(GOMAXPROCS 分支不发射,大对象路径仅加 label 不加指令)。唯一 macos 变更 =
>   数据段增长(P struct + `_mheap_lock` + 结果缓冲,均 0 值)。门:**macos-arm64
>   gen1==gen2==gen3 字节一致**(`bef4b3ae5c2f10cf481a80b03c055376`,15.55MB,+64KB 段对齐进位)、
>   g1 无 segfault;fixtures **335 PASS**(≥332);M1 js-spawn-basic/channel/panic PASS;
>   M3 非分配冒烟 `sum=136 ok`。
> - **多 M 分配安全边界(本轮实测,GC-off)**:GC 禁用下 free_lists/large_free 恒空 → 小对象必走
>   bump(→per-P mcache)、大对象必走 `_bump_alloc`(→锁)。共享态竞争面收敛为:(a)`_span_cur`
>   全局仅单 M 用,per-P mcache 与之物理隔离;(b)全局堆游标 `_heap_ptr` 经 `_mheap_lock`
>   串行;(c)`_gc_alloc_since`/`alloc_count`(纯统计,GC-off 无意义)与 startmap(每 span 占
>   互不相交的 startmap 字,两 M 各用独立 64KB span→天然不冲突)= 良性;(d)写点屏障
>   `_gc_remember` 对 young 容器早退 → 任务只改自身新分配对象则**零共享 GC 态写**。
> - **扩展冒烟(`tests/parallel/m_bringup_smoke.js` + `__par_alloc_smoke`/`_par_alloc_smoke`)**:
>   GOMAXPROCS=2 + GC-off 下 16 个**分配型**任务分布 2 个真实 OS 线程(per-P runq+窃取),
>   每任务 `_alloc` 64 个 32B 节点建单链表(tag=i+1)再遍历求和,校验 Σresults==64×136=**8704**。
>   结果只依赖 i(与两 M 交错无关)→ 确定性;并发分配若返回重叠块则和错→FAIL(损坏探测器)。
>   **验证(linux-arm64,Docker qemu,×12 稳定)**:`m-alloc: 16 allocating tasks across 2 Ms,
>   sum=8704 ok / PASS`。→ **第二个 M 上的分配首次安全**(§4-M4 mcache 目标兑现)。
> - **仍属 M5**:STW GC + 协程栈扫描(本轮 GC-off 规避)。**未做**:free_lists/large_free 加锁摘链
>   (GC-off 下恒空,无需)、`_gc_alloc_since` per-P 化(统计,GC-off 无意义)、x64 段 TLS 多 M。

`_span_cur/_span_end` 迁入 P struct(M2 已建好槽位)→ 分配快路完全无锁(bump within span);
span 用尽 → 锁 mcentral:优先 free_lists 摘链,否则 bump 切新 span(页表写在锁内)。
大对象直走 mcentral 锁。`_gc_alloc_since` per-P,溢出原子加全局。
工作量:2-3 周(分配器是热路+自举命脉,波次小步)。价值:分配密集负载的多核扩展性。

### M5 — 协作式 safepoint + STW GC(N 线程 × 全 G 栈扫描)

> **状态(真·多 M STW GC 回收已落地,2026-07-17,Go r6)**:在 M5-infra(停点 park/resume)
> 之上完成 **N=2 的真 stop-the-world 收集**——协调者停住另一 M 后,单协调者跑一轮完整
> mark(数据段根 + 协调者主栈 + `_gc_scan_other_ms` 扫已 park M 的执行栈区间)+ sweep(线性走含
> mcache span 的堆,piece#1 尾哨兵/pagemap 保证可走/可解析),再唤醒续跑。端到端 Docker 冒烟
> `_par_gc_smoke`:GOMAXPROCS=2 + GC-ON 下 M0 建 keeper 活链表(GC 根)+ 死垃圾、派发分配型任务、
> 预置 STW 旗起第二个 M(首个停点即 park)、M0 显式 `_stw_begin`→`_gc_collect`→`_stw_end`,校验
> **keeper 校验和跨 GC 存活 + 任务结果 Σ 正确 + gc_count 递增(真跑了一轮 GC)**,linux-arm64
> Docker ×8 稳定。全部 linux-arm64 门内;GOMAXPROCS=1(含 macos 自举门)逐字节不受影响。
> **下方"剩余工作"①②③④ 均已落地(见各条 [Go r6] 标注)**;⑤(N>2 的 M 注册表)+ 分配压力
> 自动触发(现由冒烟显式驱动 STW,非 `_alloc` 内联)+ x64 段 TLS 仍属后续。
>
> **[Go r6 收集器 ④]**:未新增独立 `_gc_stw_collect`,而是在既有 `_gc_collect` 的 `_gc_mark_roots`
> 之后插一条 `if(isParallel && GOMAXPROCS>1) _gc_scan_other_ms` 分支(macos/单 M 不发射/不走)→
> 复用全部 drain/sweep/步调重设,风险最小。多 M `_alloc` **不内联触发 GC**(加 `GOMAXPROCS>1 →
> 跳过`分支),GC 改由 STW 协调者显式驱动(避免协调者扫根/sweep 时另一 M 仍改堆)。回收前**无需**
> 清 mcache 游标:span 的 [mc_cur, page_end) 是被 sweep 跳过的 class=63 尾哨兵,GC 不扰,游标续用。
> 门:macos-arm64 gen2==gen3 字节一致(`cb617a0b05a9c72713427647d8e36b49`)、fixtures 351 PASS、
> 单 M GC-stress(20 万对象)node/macos/linux-arm64 三处输出一致、M1/M3/M4/M5 全部 Docker 冒烟绿。
>
> ---
> **状态(safepoint + STW park/resume 基础设施,GC-off,2026-07-16)**:交付**协作式
> 停点 + stop-the-world 的 park/resume 底盘**——各 M 在天然停点 poll 到全停请求即 park、请求者
> 等齐后独占世界、清旗 futex 唤醒续跑。全部 linux-arm64 门内。
> - **STW 协调槽(`runtime/core/parallel_sched.js` 数据段,全平台声明 0 值)**:`_stw_requested`
>   (全停请求旗,兼 futex 睡眠字)、`_stw_parked`(已 park 的 M 原子计数)、`_stw_park_observed`
>   (冒烟观测位)。P struct 尾新增 `P_SAVED_SP`(`P_SIZE` 2368→**2376**):M 在停点自存执行栈 SP,
>   挂 P 上(P 天然 per-M,经 MCTX_P)→ **免动 backend `M_CTX_REDIRECT`**。均标量,落根扫描区无害。
> - **`_safepoint_poll()`(linux-arm64)**:快路 `_stw_requested`==0 → 1 load+1 branch 返回;
>   请求时 park:存 SP→P.saved_sp、原子增 `_stw_parked`、futex 睡在 `_stw_requested`(先查后睡免
>   丢唤醒)、醒后原子减返回。只用 A/V 暂存器 → 调用者 callee-saved 天然保活。
> - **停点插桩(两处天然停点,均未持锁、不在协程栈内)**:①`_par_sched_run` 调度环**圈首**
>   (对齐设计"循环回边 poll":去分配化紧循环靠调度圈边界停);②`_mcache_refill` 入口(取
>   `_mheap_lock` **之前** poll → 免持锁 park 死结)。两处皆 linux-arm64 门内。
> - **`_stw_begin(target)` / `_stw_end()`**:请求者 API。begin 置旗(release)+ 自旋等
>   `_stw_parked>=target`(带 `STW_SPIN_BOUND` 安全网,防目标 M 已退出时死等)→ 达标独占世界;
>   end 清旗(release)+ futex 唤醒全部 park 的 M。请求者自身不经停点(不在调度环 poll)。
> - **HARD INVARIANT 守住**:上述读写体**仅 linux-arm64 发射**(macos/x64/wasm:poll 在
>   linux-only 体内、`_par_stw_smoke` 发桩);macos-arm64 自举门 `_alloc`/`_gc_*`/调度器**逐字节
>   不变**。macos 变更仅:数据段增 3 槽 + P +8B(0 值)+ 编译器多一条 `__par_stw_smoke` shim 分支。
>   门:**macos-arm64 gen1==gen2==gen3 字节一致**(`699ce6e30714c755d71427e5ba136a28`,15.70MB,
>   +48KB 段对齐进位)、g1 无 segfault;fixtures **339 PASS**(≥339);M1/M3/M4 冒烟全绿。
> - **STW 冒烟(`tests/parallel/m_bringup_smoke.js` + `__par_stw_smoke`/`_par_stw_smoke`)**:
>   GOMAXPROCS=2 + GC-off 下起第二个 M 跑 16 个非分配任务,M0 作请求者跑一次 STW 往返
>   (`_stw_begin(1)`→等 M1 在调度环圈首停点 park→`_stw_end` 唤醒),再一同排空、join,校验
>   Σresults==**136** 且 park 往返被观测(`_stw_park_observed`==1)。长任务(SMOKE_BUSY)保证 M1
>   被停点截住的交叠窗口(同 M3/M4 方法)。**验证(linux-arm64,Docker qemu,×15 稳定)**:
>   `m-stw: STW park/resume roundtrip across 2 Ms, sum=136 ok / PASS`。→ **协作式停点 + park/resume
>   往返首次跨 2 M 端到端生效**(§4-M5 停点机制目标兑现)。
> - **剩余工作(真 STW GC 回收,须串行 agent A/协程引擎;本轮**不**动共享 GC 热路以守定点)**:
>   ① **mcache↔sweep 可遍历性 — [Go r6 已落地]**:`_mcache_refill` 改为镜像全局 `_alloc_span_new`
>      的哨兵纪律 —— reserve 恰好 gap+SPAN(无 post-region)、在 [expected, aligned) 写 gap 哨兵
>      (class=63)、置 pagemap[(aligned-heap_base)>>16]=class+1;首块=aligned,其后每次分配经
>      共享尾 `_alloc_span_hdr` 写 [mc_cur, page_end) 尾哨兵 → 整段自 heap_base 到 heap_ptr
>      **sweep 线性可走 + mark O(1) pagemap 可解析**。后续 refill 的 expected 已 64k 对齐 → gap=0
>      连续无洞。门:macos-arm64 gen2==gen3 字节一致(`0b3d18039538de9b85882c9f9a566733`)、
>      fixtures 351 PASS、M1/M3/M4/M5 冒烟 Docker linux-arm64 全绿(alloc sum=8704 不退化)。
>   ② **每 M 根覆盖 — [Go r6 停点侧已落地]**:`_safepoint_poll` park 时除存 SP→P.saved_sp,
>      另记录当前执行栈上界 P.stack_hi(g0 停点取 P.g0_hi=`_m_thread_entry` 记的线程栈顶;协程栈
>      停点取 `_scheduler_current` 协程的 stack_base+stack_size)。**寄存器根经 prologue 自然落栈**:
>      `_par_sched_run`/`_alloc`/`_mcache_refill` 的 callee-saved 活堆指针在各自 prologue 已压栈,
>      落入 [saved_sp, stack_hi) 被扫;停点是 call,caller-saved 按 ABI 已死,无需显式 spill。
>      **扩展根扫描 `_gc_scan_other_ms`** + 收集器接线见 [Go r6 ④]。
>   ③ **协程栈区间 — [Go r6 以 park-时惰性记录替代]**:不碰共享协程引擎(coroutine.js 的
>      resume/yield),改在 linux-only 的 `_safepoint_poll` park 时按 `_scheduler_current` 现算
>      "运行中 G 栈区间"(§1.4 第一刀的等价、更小碰面积实现);挂起 G 栈仍经堆保守链免费。
>      `MCTX_CUR_STACK_LO/HI` 预留槽本轮未用(park 惰性法免维护 resume/yield 双向切换)。
>   ④ **linux-only STW 收集器 — [Go r6 已落地]**:未新增独立收集器,而在既有 `_gc_collect` 的
>      `_gc_mark_roots` 后插 `if(isParallel&&GOMAXPROCS>1) _gc_scan_other_ms`(macos/单 M 不发射/
>      不走),复用 drain/sweep/步调重设。多 M `_alloc` 加 `GOMAXPROCS>1→跳过内联 GC`;GC 由 STW
>      协调者显式驱动。mcache 游标**无需**回收前清:span 尾 [mc_cur,page_end) 是 sweep 跳过的
>      class=63 哨兵,GC 不扰。冒烟 `_par_gc_smoke` GC-ON 端到端验证(见上方状态)。
>   ⑤ **M 注册表 for N>2 — [Go r7 核心已落地]**:`_p_array` 即 P/M 注册表(容量 P_MAX 由
>      2 增至 **4**);三处硬编码"另一个 P"已改为**遍历全部 P_MAX 份**:(a)`_par_sched_run`
>      窃取环遍历全部 P、跳过自身;(b)`_gc_scan_other_ms` 遍历全部 P、跳过①协调者自身(=
>      `_m_current_p`)②未 park 者(saved_sp==0)→ 对每个已 park 的他 M 扫 [saved_sp,stack_hi);
>      (c)`_safepoint_poll` resume 时清 P.saved_sp=0(N>2 多 GC 周期正确性:防误扫已 resume、
>      正在运行的 M 的陈旧栈区间;N=2 单周期无此问题)。park 计数 `_stw_parked` 走全局原子,
>      `_stw_begin(target)` 的 target 已是参数(N 一般)。**仍待**:协调者恒 M0(其主栈经全局
>      `_stack_base` 扫);"非 M0 M 作协调者"需 per-M `_stack_base`(§1.2-D)——本轮不做,冒烟均
>      由 M0 驱动 STW。门:macos-arm64 gen1==gen2==gen3 字节一致(`2af046719bcfaea0f339a2fa61b2366a`,
>      仅数据段增 P_MAX×P_SIZE 全 0 槽)、fixtures 359 PASS、N=2 全部 M1–M5 Docker 冒烟不退化。
>      **GOMAXPROCS=3 调度 + GC 冒烟见下方 [Go r7]。** 分配压力自动触发 STW(现冒烟显式驱动)
>      + x64 段 TLS 多 M 亦属后续。
>
> **[Go r7] GOMAXPROCS=3 端到端验证(linux-arm64,Docker):**
> - **起跑一般化**:`runtime/core/m_bringup.js` 抽出 `_m_bringup_at(A0=P 指针)`(mmap 上下文 +
>   置 MCTX_P=入参 P + g0 + 起线程),`_m_bringup_second` 委托 `_m_bringup_at(&_p_array[1])`
>   (保 N=2 冒烟 ABI)。`parallel_sched.js` 加两个共享叶子 `_m_start_extras`(起 k=1..gomaxprocs-1
>   个额外 M,句柄存 `_m_handles[k]`)/`_m_join_extras`(逐一 join);`_par_smoke`/`_par_gc_smoke`
>   **改为 nprocs 参数化**(A0=nprocs → 写 `_gomaxprocs`、用两叶子起/join、STW target=nprocs-1),
>   N=2 走同一码路(循环恰 1 圈)→ 零重复代码、footprint 最小(避 §1.5 布局悬崖,见下)。
> - **starvation 修复**:`_stw_begin` 自旋圈内加 `sched_yield`(arm64 №124),避免请求者热自旋
>   饿死尚未 park 的多个 worker M(N>2 + CPU 超订时曾偶发自旋预算耗尽误判超时 → gc 冒烟 flake)。
> - **冒烟**:`__par_smoke_n`(nprocs=3 调度)/`__par_gc_smoke_n`(nprocs=3 真 STW GC)shim 探针
>   (`compiler/functions/functions.js`)+ `tests/parallel/m_bringup_smoke.js` 两行。**验证
>   (linux-arm64 Docker,×15 全绿)**:`m-sched3: 16 tasks across 3 Ms, sum=136 ok` +
>   `m-gc3: N>2 STW GC across 3 Ms, keeper survived + tasks ok + gc ran` —— 16 任务跨 **3 个真实
>   OS 线程** 由一般化窃取排空;M0 停住 M1+M2 后 `_gc_collect` 的 `_gc_scan_other_ms` 遍历全部 P
>   扫 M1+M2 各自 park 的 g0 栈,keeper 活链表跨 GC 存活、gc_count 递增。
> - **§1.5 布局悬崖教训(本轮实测)**:首版把 N=3 冒烟写成**独立复制** `_par_smoke_n`/`_par_gc_smoke_n`
>   (+341 行编译器源码)→ 触发布局位置敏感振荡:gen1==gen2 但 **gen2 编译 cli.js 非确定性产出
>   31MB 膨胀壳**(同一 g2 二进制、同一输入,md5 在 `5de0…`(16MB 正确)与 `4a48…`(31MB 坏)间
>   随机跳)。**刀法**=参数化去重(净减源码)而非新增大函数 → 回到确定性定点。**教训:多 M 冒烟
>   增量必须复用现有编排、参数化,严禁复制粘贴大 codegen 方法。** 门:macos-arm64
>   gen1==gen2==gen3==gen4 字节一致(`3b4051917108f25db1295a233b73f1dd`,16MB,×8 稳定)、
>   fixtures 359 PASS、N=2 全部 M1–M5 Docker 冒烟不退化。
>
> 对齐 Go 1.0-1.4(STW 全停;并发 GC 明确远期):
1. **先修 §1.4 的协程栈扫描**:协程切换记录 M.cur_stack_lo/hi,根扫描按区间;
   删"协程栈上推迟 GC"补丁。单 M 下先过门 — 这刀独立价值:协程重负载下 GC 及时性变好。
2. safepoint 协议:GC 请求者 CAS `gc_running`=1 → 置各 P 的 poll 旗(P struct 内,
   TLS 寻址一条 load)→ 各 M 在停点(① `_alloc` 入口——已有查阈值形态;② 调用点 prologue
   可选;③ **循环回边 poll**——必须新增,否则 `for(;;)i++` 这类去分配化循环永不停,
   解箱支柱恰恰在制造这类循环)自 spill 寄存器(`gc_regsave` per-M)→ 记录 SP → futex 睡。
   请求者等 running-M 计数归零 → 扫描:数据段一次 + 每 M `[SP_m, cur_stack_hi_m)` +
   挂起 G 栈(堆链保守标记,免费)→ mark/sweep(现引擎原样,单协调者)→ 唤醒。
   回边 poll 成本(load+branch)与五大支柱冲突 → 仅在"可能无限不停"的循环插
   (有调用/分配的循环免插),编译期判定。
3. wb 缓冲(per-P rs/box)STW 时合并回全局记忆集。
工作量:3-5 周。风险最高的里程碑(碰 GC+协程交界,agent A 领地,须串行排期)。

### M6 — channel 跨 M 唤醒 futex 化 + 收尾

channel 的 park/wake 从纯调度队列改为:同 P 快路不变,跨 P 入队 + 唤醒空闲 M
(futex/ulock/WaitOnAddress);Symbol/closure-props 注册表锁;macOS/windows 线程后端补齐。
工作量:2-3 周。

### 价值-成本判断

**最早的真实多核加速在 M3(+最小 M4)**:linux 上纯计算 `go` 负载。
完整可用(含 GC 的一般负载)= M2+M3+M4+M5 ≈ 单人 3-4 个月,全程定点门风险敞口。
诚实结论:这是 asm.js 迄今最大的运行时工程,超过分代 GC;但清单显示地基比预想好 —
span 分配器天然 mcache 形态、协程即 G、IC 天然良性竞争、用户全局按 Go 语义免迁,
真正的焦土只有 M2 的 TLS 化和 M5 的栈扫描重构两块。

---

## 5. 数据竞争立场(用户文档草案)

- **共享堆,按引用传递**:`go` 闭包捕获与 channel 传递均不拷贝(与 worker_threads 相反)。
- **channel 是唯一受祝福的同步原语**("share memory by communicating")。
- **普通对象上的竞争后果自负,且比 Go 更重**:JS 对象的属性表/数组的 length+data_ptr/
  字符串拼接皆多字不变量,并发裸写可致**内存损坏级**故障(越界/悬垂),不止值错乱 —
  Go 对 slice/interface 竞争同样如此,立场一致,但必须在文档里加粗。
- 单字(8B 对齐)读写不撕裂(两架构保证);对象图一致性无任何保证。
- race detector 是远期奢侈品,不承诺。
- IC/memo 站点已按 §1.2-G 设计为竞争安全(自验证/CAS 发布),**运行时自身**不因用户竞争
  而损坏的边界:运行时全局(分配器/GC/注册表)竞争安全;用户堆对象不在此列。

---

## 6. 微原型决定:本阶段跳过

理由:① 宿主是 macos-arm64,linux clone 冒烟件无法本机执行,而模拟环境已知不可信
(见"模拟环境自举验证失效":Rosetta/Docker 下自编译即产空壳,验证信噪比过低);
② 任何新运行时 helper 都进所有产物 → 触发布局位置敏感雷区,而 agent A 正在协程核心
作业,不宜叠加字节漂移;③ §2.1 的 clone 配方(号/旗标/子栈/SETTLS/CLEARTID-join)
已细化到可直接实现的程度,原型的信息增量小。M3 开工时以 linux 真机/CI 首验。

## 7. 风险 Top 5

1. **M2 TLS 化的定点/布局风险**:全量字节漂移 × "自编译布局位置敏感振荡"(+32K 稳/
   +64K 炸的非单调雷)。缓解:波次迁移每波过门;x28 寻址在 arm64 净缩产物是对冲。
2. **M5 栈扫描重构踩协程引擎**:cur_stack 记录点(resume/yield)正是 agent A 作业区与
   历史 bug 高发区(V4 被踩/裸写容器)。缓解:与 M1 agent 串行排期,先单 M 落地过门。
3. **x64 无空闲 GPR**:段 TLS 三 OS 三套设基,windows TEB 槽位偏移是半文档 ABI;
   x64 寄存器压力已到 S5 落栈的程度,任何新增隐性寄存器需求都无处安放。
4. **macOS 私有线程 ABI**(bsdthread_*/ulock):随大版本漂移即断,Go 的前车之鉴;
   缓解:版本探针 + 优雅降级单 M + "arm64 自举冻结"约束下绝对增量。
5. **safepoint 回边 poll 与性能五大支柱对撞**:解箱/内联支柱制造的去分配化紧循环
   恰是必须插 poll 的循环;缓解:仅"无调用无分配"循环插 poll + 热基准实测护栏。

---

## 附:本研究的实证锚点(便于复核)

- 数据段注册主体:`runtime/core/allocator.js:3851-4016`(generateDataSection)。
- GC 根扫描:`runtime/core/allocator.js:3005-3062`(_gc_mark_roots);
  跳过区语义 3955-3960;协程栈推迟 GC:736-742。
- 协程布局:`runtime/async/coroutine.js:8-41`(CORO_*,stack_base@+16,ARG@+112);
  调度器全局:999-1013。
- `_call_argc` ABI 契约:`runtime/core/allocator.js:3868-3873` 注释。
- IC 站点发射:`compiler/expressions/members.js:100-140`;memo 族:
  `compiler/expressions/expressions.js:806-850`。
- 寄存器映射:`backend/arm64.js:50-82`(x25-x28 空闲)、`backend/x64.js:39-78`(GPR 满)。
- PE kernel32 IAT:`binary/pe.js:23-24,556`。
- 门基线:gen1==gen2==gen3 md5 `f2519054dbd1576560e9cb74f3c8ffdf`(本研究零代码改动)。
