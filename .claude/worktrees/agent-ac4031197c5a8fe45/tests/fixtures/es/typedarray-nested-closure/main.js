const ta = new Int32Array([1, 2, 3, 4]);
// forEach inside a nested closure — receiver type not statically inferred (was a crash)
console.log((() => { let s = 0; ta.forEach((x) => { s += x; }); return s; })());
console.log((() => { const out = []; ta.forEach((x, i) => out.push(i + ":" + x)); return out.join(","); })());
console.log((() => [...ta.keys()].join(","))());
console.log((() => { const m = ta.map((x) => x * 2); return m.length + "|" + m[0] + "," + m[3]; })());
console.log((() => { const f = ta.filter((x) => x > 2); return f.length + "|" + f[0] + "," + f[1]; })());
console.log((() => ta.reduce((s, x) => s + x, 0))());
