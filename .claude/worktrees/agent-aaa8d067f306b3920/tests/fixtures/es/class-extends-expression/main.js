// class C extends (arbitrary expression): value-based superclass resolution.

class A { m() { return "A"; } static make() { return "A.make"; } }
class B { m() { return "B"; } }

// extends a ternary
const useA = true;
class D1 extends (useA ? A : B) {}
console.log("ternary-true " + new D1().m());   // A
class D2 extends (false ? A : B) {}
console.log("ternary-false " + new D2().m());   // B

// extends a call that returns a class, with super.m()
function pick() { return A; }
class D3 extends pick() { m() { return "D3-" + super.m(); } }
console.log("call-super " + new D3().m());       // D3-A

// extends a member expression
const ns = { Base: class { g() { return "ns.g"; } } };
class D4 extends ns.Base {}
console.log("member " + new D4().g());           // ns.g

// class expression with identifier superclass (anonymous)
class Base5 { v() { return "v5"; } }
const K = class extends Base5 {};
console.log("classexpr " + new K().v());         // v5

// super() through an expression superclass + fields + instanceof
class Acc { constructor(n) { this.n = n; } }
const getAcc = () => Acc;
class D6 extends (getAcc()) {
  constructor(n) { super(n); this.doubled = n * 2; }
}
const d6 = new D6(21);
console.log("super-fields " + d6.n + " " + d6.doubled + " " + (d6 instanceof Acc)); // 21 42 true

// mixin: a factory returning a class that extends a module-level class, with super
function withLog(Sup) {
  return class extends Base5 { v() { return "log+" + super.v(); } };
}
class D7 extends withLog(A) {}
console.log("mixin " + new D7().v());            // log+v5
