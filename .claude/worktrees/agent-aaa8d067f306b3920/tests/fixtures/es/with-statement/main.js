// read: with-object props shadow lexical
var o = { x: 10, y: 20 };
var a = 100;
with (o) { console.log(x + y, x + a); }
// lexical fallback when property absent
var count = 5;
with ({}) { console.log(count); }
// assignment to with-property
var p = { v: 1 };
with (p) { v = 42; }
console.log(p.v);
// method call on with-object
var m = { greet: function () { return "hi"; }, n: 7 };
with (m) { console.log(greet(), n); }
// update expressions
var c = { k: 0 };
with (c) { k = k + 5; k++; ++k; }
console.log(c.k);
with (c) { console.log(k++, k, --k); }
// assignment falls to lexical when absent
var e = 100;
with ({}) { e++; }
console.log(e);
