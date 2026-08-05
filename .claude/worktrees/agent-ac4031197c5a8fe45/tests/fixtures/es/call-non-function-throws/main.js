const o = { greet(n) { return "hi " + n; } };
console.log(o.greet("x"));
class C { constructor(v) { this.v = v; } m() { return this.v * 2; } }
console.log(new C(21).m());
console.log([1, 2, 3].map((x) => x + 1).join(","));
try { const bad = { x: 5 }; bad.x(); } catch (e) { console.log("caught1"); }
try { let notfn; notfn(); } catch (e) { console.log("caught2"); }
