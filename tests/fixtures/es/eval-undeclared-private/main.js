var executed = false;
class C {
  f() {
    eval("executed = true; this.#x;");
  }
}
var threw = false;
try { new C().f(); } catch (e) { threw = e instanceof SyntaxError; }
console.log(threw);
console.log(executed);
