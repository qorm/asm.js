// Derived-class field initializers run AFTER super() returns (can read super-set state).
const order = [];

class A {
  constructor(v) { this.a = v; order.push("super"); }
}
class C extends A {
  b = this.a + 9;                 // reads this.a set by super()
  c = order.push("field");        // side-effect ordering probe
  constructor(v) { super(v); this.d = this.b + this.a; }
}
const o = new C(1);
console.log("b " + o.b);          // 10
console.log("d " + o.d);          // 12
console.log("order " + order.join(","));  // super,field

// default (implicit) derived constructor also inits fields after super
class C2 extends A { e = this.a * 2; }
console.log("default-ctor " + new C2(5).e); // 10

// private field reads super state
class C3 extends A {
  #p = this.a + 100;
  read() { return this.#p; }
  constructor() { super(7); }
}
console.log("private " + new C3().read());  // 107

// multiple fields in order, each reading the previous
class C4 extends A {
  p = this.a + 1;
  q = this.p + 1;
  constructor() { super(100); }
}
const o4 = new C4();
console.log("chain " + o4.p + " " + o4.q); // 101 102

// base class (no extends) field ordering unchanged: fields before ctor body
class Base { x = 3; y = this.x + 1; constructor() { this.z = this.y; } }
const b = new Base();
console.log("base " + b.x + " " + b.y + " " + b.z); // 3 4 4
