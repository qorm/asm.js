// WeakMap/WeakSet carry a distinguishing header weakness bit so
// Object.prototype.toString brands them apart from Map/Set (which share the type byte).
var O = Object.prototype.toString;
console.log(O.call(new WeakMap()));
console.log(O.call(new WeakSet()));
console.log(O.call(new Map()));
console.log(O.call(new Set()));
// operations still work through the shared Map/Set routing
var wm = new WeakMap(); var k = {}; wm.set(k, 7);
console.log(wm.get(k), wm.has(k));
var ws = new WeakSet(); var o = {}; ws.add(o);
console.log(ws.has(o), ws.has({}));
var m = new Map([["a", 1]]); console.log(O.call(m), m.get("a"), m.size);
