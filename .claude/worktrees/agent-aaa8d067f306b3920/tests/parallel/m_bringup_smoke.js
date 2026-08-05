// 第二个 M 起跑冒烟测试(M3 预研,docs/PARALLEL_DESIGN.md §4-M3)。
// 验证:GOMAXPROCS 门开(=2)时,__m_bringup_smoke 起第二个 OS 线程,线程入口蹦床把
// x28 绑到第二个 M 的上下文块、进 _scheduler_run(空队列即返回)、退出;主 M futex-join。
// 仅 linux-arm64 / linux-x64 目标有真实线程体;其余目标 __m_bringup_smoke 恒返 -1。
//
// 编译:node cli.js tests/parallel/m_bringup_smoke.js --target linux-arm64 -o mbring-linux-arm64
// 运行(Docker):docker run --rm --platform linux/arm64 -v $PWD:/w alpine /w/mbring-linux-arm64
//
// 期望输出(linux):
//   m-bringup: second M joined
//   PASS
//
// 注意:GOMAXPROCS=1 是默认单 M 定点;本探针内部临时开门到 2 起跑、事后复位回 1,
// 不改变默认行为。输出全用常量串(绕开既有 x64 "串+内建返回数值" 段错误,见 clone_smoke.js)。

const r = __m_bringup_smoke();
if (r === 0) {
    console.log("m-bringup: second M joined");
} else {
    console.log("m-bringup: bringup failed (expected on non-linux)");
}

// [M3] 多 M G-M-P 调度冒烟:GOMAXPROCS=2 下 16 个任务协程分布到 2 个 M(per-P runq +
// 工作窃取),run-to-completion,校验 Σ(results[i]=i+1)==136。仅 linux-arm64 有真体。
// 期望输出(linux-arm64):
//   m-bringup: second M joined
//   m-sched: 16 tasks across 2 Ms, sum=136 ok
//   PASS
const s = __par_smoke();
if (s === 0) {
    console.log("m-sched: 16 tasks across 2 Ms, sum=136 ok");
} else {
    console.log("m-sched: failed (expected on non-linux)");
}

// [M4] 多 M 分配安全冒烟:GOMAXPROCS=2 + GC-off 下 16 个**分配型**任务分布 2 个 M
// (per-P mcache 无锁 bump + 锁保护 refill),每任务 alloc 64 个节点建链表并求 tag 和,
// 校验 Σ(results[i]=64*(i+1)) == 8704。检验第二个 M 上的分配不损坏(重叠块 → 和错)。
// 期望输出(linux-arm64):
//   m-alloc: 16 allocating tasks across 2 Ms, sum=8704 ok
const a = __par_alloc_smoke();
if (a === 0) {
    console.log("m-alloc: 16 allocating tasks across 2 Ms, sum=8704 ok");
} else {
    console.log("m-alloc: failed (expected on non-linux)");
}

// [M5] 协作式 safepoint / STW park-resume 冒烟:GOMAXPROCS=2 + GC-off 下起第二个 M,M0 作
// 请求者跑一次 STW 往返(置旗 → 等 M1 在调度环圈首停点 park → 清旗唤醒),再一同排空 16 个
// 任务、join、校验 Σresults==136 且 park 往返被观测。证明停点/park/resume 机制端到端生效。
// (真 STW GC 回收 = M5 后续。)期望输出(linux-arm64):
//   m-stw: STW park/resume roundtrip across 2 Ms, sum=136 ok
const w = __par_stw_smoke();
if (w === 0) {
    console.log("m-stw: STW park/resume roundtrip across 2 Ms, sum=136 ok");
} else {
    console.log("m-stw: failed (expected on non-linux)");
}

// [M5] 真·多 M STW GC 冒烟:GOMAXPROCS=2 + GC-ON 下 M0 建 keeper 活链表(GC 根)+ 死垃圾,
// 派发分配型任务,预置 STW 旗后起第二个 M(首个停点即 park),M0 显式停世界 `_gc_collect`
// (扩展根扫描含 M1 栈)后唤醒、排空、join。校验 keeper 校验和跨 GC 存活 + 任务结果 + gc_count 递增。
// 期望输出(linux-arm64):
//   m-gc: real multi-M STW GC, keeper survived + tasks ok + gc ran
const g = __par_gc_smoke();
if (g === 0) {
    console.log("m-gc: real multi-M STW GC, keeper survived + tasks ok + gc ran");
} else {
    console.log("m-gc: failed (expected on non-linux)");
}

// [M6 N>2] GOMAXPROCS=3 调度冒烟:M0 派发 16 个任务到 P0,起 2 个额外 M,三 M 经 per-P runq +
// 一般化窃取(遍历全部 P)排空、逐一 join,校验 Σresults==136。证明 N>2 多 M 调度端到端生效。
// 期望输出(linux-arm64):
//   m-sched3: 16 tasks across 3 Ms, sum=136 ok
const s3 = __par_smoke_n();
if (s3 === 0) {
    console.log("m-sched3: 16 tasks across 3 Ms, sum=136 ok");
} else {
    console.log("m-sched3: failed (expected on non-linux)");
}

// [M6 N>2] GOMAXPROCS=3 真 STW GC 冒烟:M0 建 keeper 活链表 + 死垃圾、派发分配型任务,预置 STW
// 旗后起 2 个额外 M(各首个停点即 park),M0 停世界 `_gc_collect`(扩展根扫描遍历全部 P 扫 M1+M2
// g0 栈)后唤醒、排空、join。校验 keeper 跨 GC 存活 + 任务结果 + gc_count 递增。
// 期望输出(linux-arm64):
//   m-gc3: N>2 STW GC across 3 Ms, keeper survived + tasks ok + gc ran
const g3 = __par_gc_smoke_n();
if (g3 === 0) {
    console.log("m-gc3: N>2 STW GC across 3 Ms, keeper survived + tasks ok + gc ran");
} else {
    console.log("m-gc3: failed (expected on non-linux)");
}

if (r === 0 && s === 0 && a === 0 && w === 0 && g === 0 && s3 === 0 && g3 === 0) {
    console.log("PASS");
} else {
    console.log("FAIL");
}
