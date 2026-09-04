class outer {
  #x = 42;
  f() {
    var self = this;
    return class inner {
      g() { return self.#x; }
    }
  }
}
var innerclass = new outer().f();
console.log(new innerclass().g());
