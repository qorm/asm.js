// [#49] RegExp shim 调用在嵌套函数/生成器体内正确解析(编译器合成的 __RE_* 调用
// 在闭包分析之后展开,须经 functionAliases 直呼 _user_ 标签而非被静默丢弃)。
// 同时覆盖 replace(re,fn) 的 arguments 对象与 matchAll+arguments。本文件在 node 下
// 运行输出须与 asm.js 逐字节一致。

// 生成器体内 exec-while(g flag)
function* ge(s) { var re = /\d+/g; var m; while ((m = re.exec(s)) !== null) yield m[0]; }
var a = []; for (var v1 of ge("a1 b22 c333")) a.push(v1);
console.log("g1", a.join(","));

// 生成器体内 exec-while(gi flag)
function* gi(s) { var re = /[a-c]/gi; var m; while ((m = re.exec(s)) !== null) yield m[0]; }
var b = []; for (var v2 of gi("AxByCz")) b.push(v2);
console.log("g2", b.join(","));

// 生成器体内 match(g)
function* gm(s) { yield s.match(/\d+/g).join("|"); }
console.log("g3", gm("x1 y22 z333").next().value);

// 生成器 yield exec 结果的分组
function* gg(s) { var re = /(\d)(\d)/g; var m; while ((m = re.exec(s)) !== null) yield m[1] + "-" + m[2]; }
var c = []; for (var v3 of gg("12 34")) c.push(v3);
console.log("g4", c.join(","));

// 普通嵌套函数内的 exec
function fexec(s) { var m = /(\w+)@(\w+)/.exec(s); return m === null ? "NULL" : m[1] + "/" + m[2]; }
console.log("f1", fexec("user@host"));

// replace(re,fn):arguments 对象
console.log("r1", "1-2".replace(/(\d)-(\d)/, function () { return arguments[arguments.length - 1]; }));
// replace(re,fn):具名参 + offset
console.log("r2", "a1b2".replace(/([a-z])(\d)/g, function (m, p1, p2, off) { return "[" + p1 + p2 + "@" + off + "]"; }));
// replace(re,str):$n
console.log("r3", "john smith".replace(/(\w+) (\w+)/, "$2 $1"));

// matchAll + arguments 组合
function tag() { return "<" + arguments[0] + "@" + arguments[1] + ">"; }
var out = [];
for (var mm of "a1b2c3".matchAll(/([a-z])(\d)/g)) { out.push(tag(mm[1], mm[2])); }
console.log("m1", out.join(""));

// arguments.length via apply(shim replace 内部路径)与 call/direct
function argc() { return arguments.length; }
console.log("a1", argc(1, 2, 3), argc.apply(null, [4, 5]), argc.call(null, 9));
