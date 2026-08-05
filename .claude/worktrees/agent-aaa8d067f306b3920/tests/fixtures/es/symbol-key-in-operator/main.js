let s = Symbol("k"), s2 = Symbol("m");
let o = {}; o[s] = 1; o.str = 2; o[s2] = 3;
console.log(s in o, s2 in o, Symbol("z") in o);
console.log("str" in o, "missing" in o);
let lit = { [s]: 9 };
console.log(s in lit);
