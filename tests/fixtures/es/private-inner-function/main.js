class C {
  #f = "Test262";
  set #m(v) { this._v = v; }
  method() {
    let self = this;
    function inner() { return self.#f; }
    function innerSet() { self.#m = "ok"; }
    innerSet();
    return inner();
  }
}
let c = new C();
console.log(c.method());
console.log(c._v);
let threw = false;
try { c.method.call({}); } catch (e) { threw = e instanceof TypeError; }
console.log(threw);
