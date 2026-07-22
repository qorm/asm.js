// L4 正向:容量翻倍跨 size-class(摊还 O(N))
let s = "";
for (let i = 0; i < 1000; i++) s += "x";
console.log(s.length, s.charCodeAt(0), s.charCodeAt(999));
let b = "seed-";
for (let i = 0; i < 500; i++) b = b + "yz";
console.log(b.length, b.slice(0, 7), b.slice(-4));
