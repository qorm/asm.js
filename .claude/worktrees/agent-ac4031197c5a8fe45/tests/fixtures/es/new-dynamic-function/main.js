// `new` on a runtime function value (parameter/variable) uses ES5 constructor
// semantics; Proxy construct forwarding works for plain-function targets.
function T() { this.v = 1; }
function mk(C) { return new C(); }
console.log(mk(T).v);                       // 1
var C2 = T;
console.log(new C2().v);                    // 1
function TA(a, b) { this.s = a + b; }
function mk2(K, x, y) { return new K(x, y); }
console.log(mk2(TA, 3, 4).s);               // 7
// explicit object return overrides
function TR() { return { custom: 9 }; }
console.log(mk(TR).custom);                 // 9
// class value through variable
class K { constructor(x) { this.k = x; } }
var CK = K;
console.log(new CK(5).k);                   // 5
// Proxy construct: no trap forwards to plain-function target
var p1 = new Proxy(T, {});
console.log(new p1().v);                    // 1
// trap doing `new target(...args)`
var p2 = new Proxy(TA, { construct: function (t, a) { return new t(...a); } });
console.log(new p2(1, 2).s);                // 3
// static paths unchanged
console.log(new T().v, new K(6).k);         // 1 6
