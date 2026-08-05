const m = new Map([["a", 1], ["b", 2]]);
for (const e of m) console.log(e[0], e[1]);
for (const [k, v] of m) console.log(k + "=" + v);
let sum = 0;
for (const [, v] of m) sum += v;
console.log(sum);
