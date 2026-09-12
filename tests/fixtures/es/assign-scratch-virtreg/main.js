"use strict";
function f() {
  var s = 10;
  s += 2;
  s *= 3;
  s -= 4;
  s /= 2;
  var x = s++;
  var y = ++s;
  return [s, x, y].join(",");
}
print(f());

function outer() {
  var c = 1;
  function inner() { return c++; }
  print(inner());
  print(c);
}
outer();

var o = { n: 1 };
o.n += 5;
print(o.n);
print(o.n++);
print(o.n);

var a = [10, 0];
a[1] += 3;
print(a[1]);
print(a[0]++);
print(a[0]);

function C() { this.n = 0; }
C.prototype.f = function () { return `${this.n++}|${this.n}`; };
print(new C().f());

var t = 0;
t &&= 5;
print(t);
t = 2;
t ||= 9;
print(t);

var z = { valueOf: function () { return 8; } };
z -= 3;
print(z);

var bits = 1;
bits |= 2;
print(bits);

var m = { k: 4 };
var k = "k";
print(m[k]++);
print(m.k);

var p = 10;
p %= 3;
print(p);
