// Proxy descriptor traps: getOwnPropertyDescriptor, defineProperty, ownKeys,
// getPrototypeOf, preventExtensions — routing through handler else forwarding.

// getOwnPropertyDescriptor trap (result is completed with defaults)
var proxied = {};
var d = Object.getOwnPropertyDescriptor(new Proxy(proxied, {
  getOwnPropertyDescriptor: function (t, k) { return t === proxied && k === "foo" && { value: "foo", configurable: true }; }
}), "foo");
console.log(d.value, d.configurable, d.writable, d.enumerable); // foo true false false

// getOwnPropertyDescriptor trap returning undefined -> undefined
console.log(Object.getOwnPropertyDescriptor(new Proxy({a:1}, { getOwnPropertyDescriptor: function () {} }), "a")); // undefined

// getOwnPropertyDescriptor forward (no trap)
console.log(Object.getOwnPropertyDescriptor(new Proxy({x:5}, {}), "x").value); // 5

// defineProperty trap
var dp = {}; var got = null;
Object.defineProperty(new Proxy(dp, {
  defineProperty: function (t, k, desc) { got = (t === dp) + "," + k + "," + desc.value; return true; }
}), "foo", { value: 5, configurable: true });
console.log(got); // true,foo,5

// ownKeys trap -> getOwnPropertyNames / Reflect.ownKeys
console.log(Object.getOwnPropertyNames(new Proxy({}, { ownKeys: function () { return ["a", "b", "c"]; } })).join(",")); // a,b,c
console.log(Reflect.ownKeys(new Proxy({}, { ownKeys: function () { return ["k1", "k2"]; } })).join(",")); // k1,k2
console.log(Object.keys(new Proxy({x:1, y:2}, {})).join(",")); // x,y (forward)

// getPrototypeOf trap
var fp = {};
console.log(Object.getPrototypeOf(new Proxy({}, { getPrototypeOf: function () { return fp; } })) === fp); // true

// preventExtensions trap
var pe = {}; var peSaw = false;
Object.preventExtensions(new Proxy(pe, { preventExtensions: function (t) { peSaw = (t === pe); return Object.preventExtensions(pe); } }));
console.log(peSaw); // true

// normal objects entirely unaffected
var n = {}; Object.defineProperty(n, "z", { value: 9, writable: false });
var nd = Object.getOwnPropertyDescriptor(n, "z");
console.log(n.z, nd.writable, nd.enumerable); // 9 false false
