var fs = [];
for (let i = 0; i < 3; i++) { fs.push(() => i); }
console.log(fs.map(f => f()).join(","));
var os = [];
for (const s of ["a", "b", "c"]) { os.push(() => s); }
console.log(os.map(f => f()).join(","));
var ks = [];
for (const k in { p: 1, q: 2 }) { ks.push(() => k); }
console.log(ks.map(f => f()).join(","));
var cs = [];
for (let a = 0, b = 10; a < 3; a++, b++) { cs.push(() => a + ":" + b); }
console.log(cs.map(f => f()).join(","));
