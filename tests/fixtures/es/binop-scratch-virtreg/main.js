"use strict";
function bits(a, b) {
  return (a | b) & (a ^ 3);
}
print(bits(1, 2));

function land(a, b) {
  return a && b;
}
print(land(0, 9));
print(land(4, 5));

print("a" + "b" + "c");
print("x" < "y");

function f() { return 1; }
function g() { return 2; }
print(f() | g());

var o = { n: 1 };
function base() { return o; }
base().n += 4;
print(o.n);

var k = "n";
o[k] += 1;
print(o.n);
