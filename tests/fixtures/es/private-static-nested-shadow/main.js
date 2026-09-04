var C = class {
  static #m = "outer class";
  static fieldAccess() { return this.#m; }
  static B = class {
    get #m() { return "inner class"; }
    static access(o) { return o.#m; }
  };
};
console.log(C.fieldAccess());
var b = new C.B();
console.log(C.B.access(b));
var threw = false;
try { C.B.access(C); } catch (e) { threw = e instanceof TypeError; }
console.log(threw);
