"use strict";
var m = new Map();
m.set("a", 1);
m.set("b", 2);
var ks = [];
m.forEach(function (v, k) { ks.push(k); });
console.log(ks.join(""));
var n = 0;
for (var e of m) n++;
console.log(n);

var rab = new ArrayBuffer(4, { maxByteLength: 8 });
var ta = new Uint8Array(rab, 0, 4);
ta.fill(1);
console.log(ta[0] + "," + ta[1] + "," + ta[2] + "," + ta[3]);
var fixed = new Uint8Array(4);
fixed.fill(1);
console.log(fixed[0] + "," + fixed[1] + "," + fixed[2] + "," + fixed[3]);

function Sp(n) { return new Uint8Array(n); }
var sample = new Uint8Array([1, 2, 3]);
sample.constructor[Symbol.species] = Sp;
var filtered = sample.filter(function (x) { return x !== 2; });
console.log(filtered.length + "," + filtered[0] + "," + filtered[1]);
