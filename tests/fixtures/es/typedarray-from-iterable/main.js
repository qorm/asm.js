var src = [1, 0, 0, 1, 0, 42, 42, 0, 1];
var obj = {};
obj[Symbol.iterator] = function () { return src[Symbol.iterator](); };
var expected = new Uint8Array(obj);
console.log(expected.length);
console.log(Array.prototype.join.call(expected, ","));
var C = Uint8Array;
var dyn = new C(obj);
console.log(dyn.length);
console.log(Number([]));
var sample = new C(9);
sample.set(["1", "", false, true, null, { valueOf: function () { return 42; } }, { toString: function () { return "42"; } }, [], [1]]);
console.log(Array.prototype.join.call(sample, ","));
try { new C([1]).toSorted(null); console.log("no throw"); }
catch (e) { console.log(e.name); }
