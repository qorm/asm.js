// Callable Proxies work as array-method callbacks; function subscript keys
// (symbol/computed) hit the closure-props side table.
var p = new Proxy(function (x) { return x * 2; }, {});
console.log([1, 2, 3].map(p).join(","));    // 2,4,6
var pt = new Proxy(function () {}, { apply: function (t, th, a) { return a[0] * 10; } });
console.log([1, 2].map(pt).join(","));      // 10,20
var seen = [];
new Proxy(function (x) { seen.push(x); }, {})
// eslint-disable-next-line no-unused-expressions
;[7, 8].forEach(new Proxy(function (x) { seen.push(x); }, {}));
console.log(seen.join(","));                // 7,8
console.log([1, 2, 3].filter(new Proxy(function (x) { return x > 1; }, {})).join(",")); // 2,3
console.log([1, 2, 3].reduce(new Proxy(function (a, c) { return a + c; }, {}), 0));     // 6
// function subscript keys
var s = Symbol("k");
var f = function () {};
f[s] = 9;
var key = "tag";
f[key] = "T";
f.x = 1;
console.log(f[s], f[key], f.tag, f["x"], f.x); // 9 T T 1 1
// Set/array/class-static subscripts unaffected
var st = new Set([1, 2]);
class SC { static v = 3; }
console.log(st.size, st.has(1), [9][0], SC["v"]); // 2 true 9 3
