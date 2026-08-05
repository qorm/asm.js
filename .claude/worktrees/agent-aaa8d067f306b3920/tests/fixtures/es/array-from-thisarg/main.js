// Array.from(x, mapFn, thisArg): the 3rd arg binds mapFn's `this`.
// array-like object
console.log(Array.from({ 0: "foo", 1: "bar", length: 2 }, function (e, i) { return e + this.baz + i; }, { baz: "d" }) + "");
// generator instance
var it = (function* () { yield "foo"; yield "bar"; yield "bal"; }());
console.log(Array.from(it, function (e, i) { return e + this.baz + i; }, { baz: "d" }) + "");
// real array
console.log(Array.from([10, 20], function (e) { return e + this.b; }, { b: 1 }) + "");
// string
console.log(Array.from("ab", function (c, i) { return c + this.b + i; }, { b: "-" }) + "");
// Set
console.log(Array.from(new Set([1, 2]), function (e) { return e * this.m; }, { m: 10 }) + "");
// typed array
console.log(Array.from(new Int8Array([3, 4]), function (e) { return e + this.k; }, { k: 100 }) + "");
// no mapFn still works
console.log(Array.from([1, 2, 3]) + "");
// mapFn without thisArg still works
console.log(Array.from({ length: 3 }, function (e, i) { return i; }) + "");
