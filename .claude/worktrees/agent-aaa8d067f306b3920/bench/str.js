// 字符串拼接基准:累加(暴露不可变串 O(N²) 拷贝)
var s = "";
for (var i = 0; i < 200000; i++) { s = s + "x"; }
console.log(s.length);
