// User function/class .name and .length reification (matching node).
function foo(a, b) {}
console.log(foo.name, foo.length);            // foo 2
const bar = () => {};
console.log(bar.name, bar.length);            // bar 0
const baz = function (x) {};
console.log(baz.name, baz.length);            // baz 1
const named = function myName(x, y, z) {};
console.log(named.name, named.length);        // myName 3
const obj = { m(p, q) {}, arw: (a) => {} };
console.log(obj.m.name, obj.m.length);        // m 2
console.log(obj.arw.name, obj.arw.length);    // arw 1
class C {}
console.log(C.name, C.length);                // C 0
class D { constructor(a, b, c) {} }
console.log(D.name, D.length);                // D 3
function defs(a, b = 1, c) {}
console.log(defs.length);                     // 1
function rest(a, ...r) {}
console.log(rest.length);                     // 1
