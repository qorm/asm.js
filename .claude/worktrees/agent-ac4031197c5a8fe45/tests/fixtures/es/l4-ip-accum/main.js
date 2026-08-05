// L4 正向:累加器多形态(s = s + e / s += e;字面量/模板/变量/数字后缀)
let s = "";
for (let i = 0; i < 100; i++) s = s + "ab";
console.log(s.length, s.slice(0, 4), s.slice(-4));
let t = "x";
for (let i = 0; i < 50; i++) t += i % 10;
console.log(t.length, t.slice(0, 6), t.slice(-3));
let u = "";
for (let i = 0; i < 30; i++) u = u + `v${i},`;
console.log(u.length, u.slice(0, 5), u.slice(-4));
let w = "q";
for (let i = 0; i < 10; i++) { let c = String.fromCharCode(65 + i); w = w + c; }
console.log(w);
