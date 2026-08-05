const t = { a: 1 };
const p = new Proxy(t, { get: (o, k) => k === "b" ? 99 : o[k], set: (o, k, v) => { o[k] = v * 2; return true; }, has: (o, k) => k === "magic" || k in o });
p.x = 5;
const keys = Object.keys(new Proxy({ m: 1, n: 2 }, {})).join(",");
const dp = new Proxy({ q: 1 }, { deleteProperty: (o, k) => { delete o[k]; return true; } });
delete dp.q;
const ok = p.a === 1 && p.b === 99 && ("magic" in p) && t.x === 10 && keys === "m,n" && !("q" in dp);
console.log(ok ? "proxy-traps-ok" : "proxy-traps-FAIL");
