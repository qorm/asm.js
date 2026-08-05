// Logical compound assignment on a member with accessors must SHORT-CIRCUIT the
// store: on ||= truthy / &&= falsy / ??= non-nullish, the setter must NOT run.
function mk(getv) { var i = 0; var o = { get x() { return getv; }, set x(n) { i++; o._last = n; } }; o.calls = function () { return i; }; return o; }
// ||= : getter truthy -> no setter
var a = mk(1); a.x ||= 99; console.log(a.calls());          // 0
// &&= : getter falsy -> no setter
var b = mk(0); b.x &&= 99; console.log(b.calls());          // 0
// ??= : getter non-nullish -> no setter
var c = mk(5); c.x ??= 99; console.log(c.calls());          // 0
// ||= : getter falsy -> setter runs, stored value is rhs
var d = mk(0); d.x ||= 7; console.log(d.calls(), d._last);  // 1 7
// &&= : getter truthy -> setter runs
var e = mk(3); e.x &&= 8; console.log(e.calls(), e._last);  // 1 8
// ??= : getter nullish -> setter runs
var f = mk(null); f.x ??= 4; console.log(f.calls(), f._last); // 1 4
// plain data properties still work
var g = { v: 0 }; g.v ||= 5; console.log(g.v);              // 5
var h = { v: 3 }; h.v &&= 7; console.log(h.v);              // 7
var k = { v: null }; k.v ??= 1; console.log(k.v);           // 1
// computed member evaluates key once
var calls = 0; function key() { calls++; return "v"; } var m = { v: 0 }; m[key()] ||= 9; console.log(m.v, calls); // 9 1
// array element
var arr = [0, 5]; arr[0] ||= 3; arr[1] &&= 6; console.log(arr[0], arr[1]); // 3 6
