// enumeration forwards to target (no ownKeys trap)
var p = new Proxy({ a: 1, b: 2, c: 3 }, {});
console.log(JSON.stringify(Object.keys(p)));
console.log(JSON.stringify(Object.values(p)));
console.log(JSON.stringify(Object.entries(p)));
console.log(JSON.stringify(p));
var r = [];
for (var k in p) r.push(k + "=" + p[k]);
console.log(r.join(","));
// dynamic (computed) subscript routes through traps
var store = {};
var pt = new Proxy({ x: 10 }, {
  get(t, key) { return t[key] * 2; },
  set(t, key, v) { store[key] = v; return true; }
});
var g = "x";
console.log(pt[g], pt.x);
var s = "y";
pt[s] = 5; pt.z = 9;
console.log(store.y, store.z);
