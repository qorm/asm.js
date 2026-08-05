// Object.getOwnPropertyDescriptor on a user function's "name"/"length" yields the
// spec descriptor; defineProperty overrides are visible on subsequent reads.
var d1 = Object.getOwnPropertyDescriptor(function f(){}, "name");
console.log(d1.value, d1.writable, d1.enumerable, d1.configurable); // f false false true
var fn = function (a, b) {};
var d2 = Object.getOwnPropertyDescriptor(fn, "length");
console.log(d2.value, d2.configurable);                             // 2 true
Object.defineProperty(fn, "length", { value: 1 });
console.log(fn.length);                                             // 1
var g = function named() {};
Object.defineProperty(g, "name", { value: "custom" });
console.log(g.name);                                                // custom
// unmodified functions keep static values
function plain(x, y, z) {}
console.log(plain.name, plain.length);                              // plain 3
