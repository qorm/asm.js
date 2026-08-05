let s = Symbol("k"), s2 = Symbol("m");
let o = {}; o.a = 1; o[s] = 2; o.b = 3; o[s2] = 4;
let syms = Object.getOwnPropertySymbols(o);
console.log(syms.length);
console.log(syms[0].toString(), syms[1].toString());
console.log(syms[0] === s, syms[1] === s2);
console.log(Object.getOwnPropertySymbols({ a: 1, b: 2 }).length);
console.log(Object.getOwnPropertySymbols({ [s]: 1 }).length);
console.log(Object.getOwnPropertySymbols(o).map(sym => o[sym]).join(","));
