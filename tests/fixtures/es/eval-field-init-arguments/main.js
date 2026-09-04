var executed = false;
var C = class {
  #x = () => eval("executed = true; arguments;");
  x() { this.#x(); }
};
var threw = false;
try { new C().x(); } catch (e) { threw = e instanceof SyntaxError; }
console.log(threw);
console.log(executed);
