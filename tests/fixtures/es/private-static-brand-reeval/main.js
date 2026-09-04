function createClass() {
  return class {
    static get #m() { return "test262"; }
    static access() { return this.#m; }
  };
}
var C1 = createClass();
var C2 = createClass();
console.log(C1.access());
console.log(C2.access());
var t1 = false, t2 = false;
try { C1.access.call(C2); } catch (e) { t1 = e instanceof TypeError; }
try { C2.access.call(C1); } catch (e) { t2 = e instanceof TypeError; }
console.log(t1);
console.log(t2);
