// Map/Set keys use SameValueZero: -0 is normalized to +0 on insert, so
// iteration/forEach/get yield +0 (1/key === +Infinity, not -Infinity).
var m = new Map(); m.set(-0, "foo");
var mk; m.forEach(function (v, key) { mk = 1 / key; });
console.log(mk === Infinity);                    // true
console.log(1 / [...m.keys()][0]);               // Infinity
console.log(m.get(0), m.has(0));                 // foo true
console.log(m.get(-0), m.has(-0));               // foo true

var s = new Set(); s.add(-0);
var sk; s.forEach(function (v) { sk = 1 / v; });
console.log(sk === Infinity);                    // true
console.log(s.has(0), s.has(-0));                // true true
console.log(1 / [...s][0]);                      // Infinity

// +0 then -0 must not create a duplicate
var d = new Map(); d.set(0, "a"); d.set(-0, "b");
console.log(d.size, d.get(0));                    // 1 b

// NaN keys and normal keys unaffected
var n = new Map(); n.set(NaN, "n"); n.set(5, "five"); n.set(-3, "neg");
console.log(n.get(NaN), n.get(5), n.get(-3), n.size); // n five neg 3
