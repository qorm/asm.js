class C {
  #m() { return "Test262"; }
  getWithEval() { return eval("this.#m()"); }
}
class D {
  #m() { throw new Error("no"); }
}
let c = new C();
console.log(c.getWithEval());
let threw = false;
try { c.getWithEval.call(new D()); } catch (e) { threw = e instanceof TypeError; }
console.log(threw);
