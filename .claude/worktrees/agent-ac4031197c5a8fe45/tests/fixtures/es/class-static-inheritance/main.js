// Static methods/props inherit across `extends`; Object.getPrototypeOf(Sub) === Super.
class A {
  static make() { return "A.make"; }
  static tag = "A-tag";
  hi() { return "hi"; }
}
class B extends A {
  static own() { return "B.own"; }
}
class C extends B {}

// inherited static method + prop
console.log("static-method " + B.make());       // A.make
console.log("static-prop " + B.tag);             // A-tag
console.log("own-static " + B.own());            // B.own
// two levels deep
console.log("deep-method " + C.make());          // A.make
console.log("deep-own " + C.own());              // B.own
// override wins over inherited
class D extends A { static make() { return "D.make"; } }
console.log("override " + D.make());             // D.make
// getPrototypeOf walks the constructor chain
console.log("proto1 " + (Object.getPrototypeOf(B) === A));  // true
console.log("proto2 " + (Object.getPrototypeOf(C) === B));  // true
console.log("proto-typeof " + (typeof Object.getPrototypeOf(B))); // function
// instances still inherit instance methods
console.log("instance " + new B().hi());         // hi
// static inheritance via an expression superclass too
const g = () => A;
class E extends (g()) {}
console.log("expr-static " + E.make());          // A.make
