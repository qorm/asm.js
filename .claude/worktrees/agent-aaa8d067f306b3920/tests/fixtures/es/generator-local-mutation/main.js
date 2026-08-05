// [#52] 生成器体内本地变量跨 yield 被改写:纯标量赋值、多本地交替、闭包捕获、
// while(true) 有状态循环。生成器体跑在协程栈上,yield 切栈后 resume 须能正确
// 读写协程帧上的本地(FP 相对)。本文件在 node 下的输出须与 asm.js 逐字节一致。

// 最简:yield 前后各改一次标量本地
function* g1() { var x = 0; x = x + 1; yield x; x = x + 1; yield x; }
var it1 = g1();
console.log("g1", it1.next().value, it1.next().value, it1.next().done);

// yield 前改一次(单 yield)
function* g2() { var x = 5; x = x + 10; yield x; }
console.log("g2", g2().next().value);

// fib:while(true) 有状态,跨 yield 反复改多个本地
function* fib() { var a = 1, b = 1; while (true) { yield a; var t = a + b; a = b; b = t; } }
var f = fib(); var fo = [];
for (var i = 0; i < 10; i++) fo.push(f.next().value);
console.log("fib", fo.join(","));

// 多本地交替改写
function* multi() { var a = 1, b = 2, c = 3; yield a; a = 10; yield b; b = 20; yield c; c = 30; yield a + b + c; }
var m = multi(); var mo = [];
for (var j = 0; j < 4; j++) mo.push(m.next().value);
console.log("multi", mo.join(","));

// 闭包捕获跨 yield 改写的本地
function* clo() { var x = 10; var get = function () { return x; }; yield get(); x = 99; yield get(); }
var c2 = clo();
console.log("clo", c2.next().value, c2.next().value);

// for-of 驱动的有状态计数生成器
function* counter() { var n = 0; while (n < 5) { yield n; n = n + 1; } }
var co = [];
for (var v of counter()) co.push(v);
console.log("counter", co.join(","));
