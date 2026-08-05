class C {
  #x = 1;
  #method() { return 2; }
  static hasX(o) { return #x in o; }
  hasM(o) { return #method in o; }
}
const c = new C();
console.log(C.hasX(c), C.hasX({}));
console.log(c.hasM(c), c.hasM({}));
console.log("a" in { a: 1 }, "b" in { a: 1 });
