class C {
  get #m() { return "Test262"; }
  v = eval("this.#m");
}
console.log(new C().v);
