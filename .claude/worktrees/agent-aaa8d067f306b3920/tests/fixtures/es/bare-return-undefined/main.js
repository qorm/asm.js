// Bare `return` (no argument) must NOT swallow the following statement, and its
// value (like a natural fall-off-the-end) must be real `undefined`, not int 0.

// (1) bare return in a plain function must not eat the code after it
function f() { return }
f();
console.log("after-f");

// (2) bare return value is undefined (distinguishable from 0)
function g(a) { if (a) { return } return 9; }
console.log(g(0), g(1));
console.log(typeof g(1));

// (3) fall-off-the-end returns undefined, not 0
function h() { h.hit = 1; }
console.log(h(), typeof h());

// (4) object shorthand method with bare return (previously a COMPILE_FAIL)
var o = { m() { return } };
o.m();
console.log("after-method");

// (5) getter returning nothing yields undefined
var gobj = { get x() { return } };
console.log(gobj.x, typeof gobj.x);

// (6) class method / getter fall-through -> undefined
class C { m() { this.k = 1; } get y() { return } }
var c = new C();
console.log(c.m(), c.y);

// (7) explicit return with a value still works
function ret42() { return 42 }
console.log(ret42());
