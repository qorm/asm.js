// Object.getOwnPropertyDescriptors skips keys whose descriptor is undefined (t717),
// and basic Proxy invariant enforcement throws on trap/target inconsistency.

// getOwnPropertyDescriptors: undefined descriptor from trap is skipped
var P = new Proxy({ a: 1 }, { getOwnPropertyDescriptor: function () {} });
console.log(!Object.getOwnPropertyDescriptors(P).hasOwnProperty("a")); // true
// normal getOwnPropertyDescriptors unaffected
var d = Object.getOwnPropertyDescriptors({ a: 1, b: 2 });
console.log(d.a.value, d.b.value, d.a.writable); // 1 2 true

// preventExtensions invariant: trap returns true but target still extensible -> throw
function thr(fn) { try { fn(); return false; } catch (e) { return true; } }
console.log(thr(function () { Object.preventExtensions(new Proxy({}, { preventExtensions: function () { return true; } })); })); // true
// valid preventExtensions (target actually made non-extensible) -> no throw
var pd = {};
console.log(typeof Object.preventExtensions(new Proxy(pd, { preventExtensions: function (t) { return Object.preventExtensions(pd); } }))); // object

// getOwnPropertyDescriptor invariant: trap hides a non-configurable target prop -> throw
var g = {}; Object.defineProperty(g, "foo", { value: 2, writable: true, enumerable: true }); // configurable:false by default
console.log(thr(function () { Object.getOwnPropertyDescriptor(new Proxy(g, { getOwnPropertyDescriptor: function () { return undefined; } }), "foo"); })); // true
// configurable target prop reported undefined -> no throw (returns undefined)
console.log(Object.getOwnPropertyDescriptor(new Proxy({ x: 1 }, { getOwnPropertyDescriptor: function () { return undefined; } }), "x")); // undefined

// defineProperty invariant: new prop on non-extensible target -> throw
console.log(thr(function () { Object.defineProperty(new Proxy(Object.preventExtensions({}), { defineProperty: function () { return true; } }), "foo", { value: 2 }); })); // true
// defineProperty invariant: non-configurable desc but target prop is configurable -> throw
console.log(thr(function () { Object.defineProperty(new Proxy({ bar: true }, { defineProperty: function () { return true; } }), "bar", { value: 5, configurable: false, writable: true, enumerable: true }); })); // true
// valid defineProperty trap -> no throw
var okp = {};
Object.defineProperty(new Proxy(okp, { defineProperty: function () { return true; } }), "z", { value: 1, configurable: true });
console.log("ok");
