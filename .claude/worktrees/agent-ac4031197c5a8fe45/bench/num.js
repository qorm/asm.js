// 数值循环基准(PERF_PLAN P3):模 + 累加
var s = 0;
for (var i = 0; i < 50000000; i++) { s = s + i % 7; }
console.log(s);
