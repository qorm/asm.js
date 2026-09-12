"use strict";
function add(a, b, c) { return a + b + c; }
print(add(1, 2, 3));
print(add(add(1, 2, 0), 3, 4));

function six(a, b, c, d, e, f) { return [a, b, c, d, e, f].join(","); }
print(six(1, 2, 3, 4, 5, 6));

function m(x, y) { return this.n + x + y; }
var o = { n: 10, m: m };
print(o.m(1, 2));

function C(a, b) { this.a = a; this.b = b; }
var c = new C(7, 8);
print(c.a);
print(c.b);

function id(x) { return x; }
print(id() === undefined);

function sp(a, b, c) { return a * 100 + b * 10 + c; }
print(sp(...[1, 2, 3]));
