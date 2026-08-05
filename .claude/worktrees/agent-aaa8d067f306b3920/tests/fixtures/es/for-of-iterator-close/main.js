// for-of that breaks early calls iterator.return() (IteratorClose); normal
// completion does not; array/Set/string paths and no-return-method are unaffected.
var closed = false;
var it = { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return() { closed = true; return { done: true }; } }; } };
for (var x of it) break;
console.log(closed); // true
// normal completion: return() NOT called
var c2 = false;
var it2 = { [Symbol.iterator]() { var i = 0; return { next() { return i < 2 ? { value: i++, done: false } : { done: true }; }, return() { c2 = true; } }; } };
var sum = 0; for (var y of it2) sum += y;
console.log(sum, c2); // 1 false
// iterator without a return method: no crash
var it3 = { [Symbol.iterator]() { return { next() { return { value: 9, done: false }; } }; } };
for (var z of it3) break;
console.log("no-return-ok");
// array / Set / string break: no spurious close, correct values
var s = 0; for (var a of [1, 2, 3]) { if (a === 2) break; s += a; }
var ss = 0; for (var b of new Set([1, 2, 3])) { if (b === 2) break; ss += b; }
var str = ""; for (var ch of "abc") { if (ch === "b") break; str += ch; }
console.log(s, ss, str); // 1 1 a
// nested for-of, break inner and outer: both close
var n = 0;
var mk = () => ({ [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return() { n++; return { done: true }; } }; } });
for (var p of mk()) { for (var q of mk()) break; break; }
console.log(n); // 2
