"use strict";
var o = { x: 1 };
o.x = o.x + 2;
print(o.x);

var a = [0, 0];
a[0] = 7;
a[1] = a[0];
print(a[0]);
print(a[1]);

function f() {}
f.k = 3;
print(f.k);

var t = { n: 9 };
print(`${t.n}|${t.n = 4}|${t.n}`);

var arr = [];
arr.length = 3;
print(arr.length);

function C() { this.a = 1; this.b = 2; }
C.prototype.set = function () { this.a = this.b; this.b = 9; };
var c = new C();
c.set();
print(c.a);
print(c.b);
