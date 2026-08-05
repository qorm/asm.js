// [#72] optional computed member  a?.[i]
const a = [10, 20, 30];
console.log(a?.[0]);
console.log(a?.[2]);
let i = 1;
console.log(a?.[i]);

// nullish base short-circuits to undefined
const n = null;
console.log(n?.[0]);

// short-circuit must NOT evaluate the index expression (no side effect)
let called = 0;
function idx() { called++; return 0; }
console.log(n?.[idx()]);
console.log("called=" + called);

// object with static string key
const o = { k: 42 };
console.log(o?.["k"]);
