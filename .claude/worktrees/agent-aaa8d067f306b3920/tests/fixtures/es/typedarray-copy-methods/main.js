// TypedArray non-mutating copy methods: toReversed / toSorted / with
var a = new Uint8Array([1, 2, 3]);
var r = a.toReversed();
console.log("rev", r[0], r[1], r[2], "orig", a[0], a[1], a[2]);

var b = new Uint8Array([3, 1, 2]);
var s = b.toSorted();
console.log("sort", s[0], s[1], s[2], "orig", b[0], b[1], b[2]);

var c = new Int16Array([10, 20, 30]);
var w = c.with(1, 99);
console.log("with", w[0], w[1], w[2], "orig", c[0], c[1], c[2]);

var d = new Float64Array([1.5, 2.5, 3.5]);
console.log("wneg", d.with(-1, 9.5)[2], "orig", d[2]);
