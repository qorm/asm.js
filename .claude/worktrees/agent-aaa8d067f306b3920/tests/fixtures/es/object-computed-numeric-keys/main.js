// [#39] 普通对象数值计算键规范化:o[1] ≡ o["1"](node 语义,键恒为字符串)。
// 修前:数值键按 NaN-box 位存键槽,_object_key_eq payload 快路把小整数 double
// 全判同键 → 不同键读写塌到同一槽,且与字符串键永不相等。
var o = {};
for (var i = 0; i < 5; i++) { o[i] = i * 10; }
console.log(o[0], o[1], o[4]);
var k = 2;
console.log(o[k]);
console.log(o["3"]);
var p = {};
p[1] = "num";
console.log(p["1"]);
p["7"] = "str";
console.log(p[7]);
var keys = Object.keys(o);
console.log(keys.length, typeof keys[0], keys[0]);
console.log(1 in o, 9 in o);
delete o[1];
console.log(Object.keys(o).length);
var f = {};
f[2.5] = "half";
console.log(f["2.5"], Object.keys(f)[0]);
