class C { static [Symbol.hasInstance](n) { return typeof n === "number"; } }
console.log(typeof C[Symbol.hasInstance]);
console.log(C[Symbol.hasInstance](5), C[Symbol.hasInstance]("x"));
class D {}
let mySym = Symbol("custom");
D[mySym] = 42;
console.log(D[mySym]);
D.strProp = 7;
console.log(D.strProp, D["strProp"]);
let k = "dyn";
D[k] = 100;
console.log(D[k]);
console.log(Object.getOwnPropertySymbols(D).length);
class E { static foo() { return 1; } }
console.log(E["foo"](), E.foo());
