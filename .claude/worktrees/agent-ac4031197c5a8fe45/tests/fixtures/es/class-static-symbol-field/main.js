class E { static [Symbol.toStringTag] = "Tag"; }
console.log(E[Symbol.toStringTag]);
let sym = Symbol("z");
class G { static [sym] = 88; }
console.log(G[sym]);
class F { static ["dyn" + "amic"] = 5; static [1 + 1] = 9; }
console.log(F.dynamic, F[2]);
console.log(Object.getOwnPropertySymbols(E).length, Object.getOwnPropertySymbols(G).length);
