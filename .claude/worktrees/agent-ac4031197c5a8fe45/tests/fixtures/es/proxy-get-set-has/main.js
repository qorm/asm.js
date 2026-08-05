// get trap
const g = new Proxy({}, { get(t, k) { return "got:" + k; } });
console.log(g.foo, g["bar"]);
// get forwarding (no trap)
const gf = new Proxy({ x: 10 }, {});
console.log(gf.x, gf.y);
// set trap with side effect
const store = {};
const s = new Proxy({}, { set(t, k, v) { store[k] = v * 2; return true; } });
s.a = 5; s["b"] = 10;
console.log(store.a, store.b);
// set forwarding
const target = {};
const sf = new Proxy(target, {});
sf.z = 99;
console.log(target.z, sf.z);
// has trap for `in`
const h = new Proxy({}, { has(t, k) { return k === "yes"; } });
console.log("yes" in h, "no" in h);
// has forwarding
const hf = new Proxy({ p: 1 }, {});
console.log("p" in hf, "q" in hf);
// typeof + trap ordering
const log = [];
const p = new Proxy({}, { get(t, k) { log.push("g:" + k); return 1; }, set(t, k, v) { log.push("s:" + k); return true; } });
p.m; p.n = 2;
console.log(typeof p, log.join(","));
