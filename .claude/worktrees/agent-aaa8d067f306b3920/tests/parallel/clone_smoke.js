// clone() 冒烟测试(M3 预研,docs/PARALLEL_DESIGN.md §2.1 配方实证)
// 仅 linux-arm64 / linux-x64 目标有真实线程体;其余目标 __thread_spawn_smoke 恒返 -1。
//
// 编译:node cli.js tests/parallel/clone_smoke.js --target linux-arm64 -o smoke-linux-arm64
// 运行(Docker):docker run --rm --platform linux/arm64 -v $PWD:/w alpine /w/smoke-linux-arm64
//
// 期望输出(linux):
//   clone-smoke: spawned
//   clone-smoke: joined
//   clone-smoke: byte ok
//   PASS
//
// 注意:输出刻意全用常量串——x64 目标上"串 + 内建返回的数值"存在**先于本改动**的
// 段错误(pristine 树可复现:__alloc/__setChar 后 "v=" + __getChar(p) 在 linux-x64
// 与 macos-x64/Rosetta 均崩,arm64 全好;比较运算不受影响)。线程原语与该 bug 无关。

const buf = __alloc(64);
__setChar(buf, 0); // 共享字节清零

const h = __thread_spawn_smoke(buf);
if (h <= 0) {
    console.log("clone-smoke: spawn failed (expected on non-linux)");
    console.log("FAIL");
} else {
    console.log("clone-smoke: spawned");
    const j = __thread_join(h); // CLEARTID futex join
    if (j === 0) console.log("clone-smoke: joined");
    const v = __getChar(buf); // 子线程经共享堆写入的 42
    if (v === 42) console.log("clone-smoke: byte ok");
    if (v === 42 && j === 0) {
        console.log("PASS");
    } else {
        console.log("FAIL");
    }
}
