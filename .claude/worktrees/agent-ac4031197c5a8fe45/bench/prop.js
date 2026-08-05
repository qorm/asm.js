// 属性访问基准:对象字段读写循环
var o = { a: 0, b: 1, c: 2 };
var s = 0;
for (var i = 0; i < 20000000; i++) { o.a = o.b + o.c; s = s + o.a; }
console.log(s);
