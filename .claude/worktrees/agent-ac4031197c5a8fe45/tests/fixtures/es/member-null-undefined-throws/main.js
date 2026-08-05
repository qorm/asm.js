// Reading a property of null/undefined throws a catchable TypeError (ES).
try { const x = null; x.foo; console.log("NO"); }
catch (e) { console.log(e instanceof TypeError, e.name, e.message); }
try { const y = undefined; y.bar; console.log("NO"); }
catch (e) { console.log(e instanceof TypeError, e.name, e.message); }
try { null.baz; } catch (e) { console.log(e.message); }
// non-nullish bases keep returning undefined for missing props (no throw)
const o = { a: 1 };
console.log(o.a, o.missing);
console.log("abc".length, "abc".missing);
const arr = [1, 2];
console.log(arr.length, arr.nope);
console.log("done");
