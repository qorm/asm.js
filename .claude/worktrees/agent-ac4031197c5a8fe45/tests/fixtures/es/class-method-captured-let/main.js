// A `let`/param captured (and written) by sibling closures inside a class
// method must be shared (boxed), not copied per closure.
class C {
  run() {
    const self = this;
    let count = 0;
    const inc = () => { count = count + 1; };
    const get = () => count;
    inc(); inc();
    self.tag = "t";
    console.log(get(), count, self.tag);   // 2 2 t
  }
  withParam(n) {
    const inc = () => { n = n + 1; };
    const get = () => n;
    inc(); inc(); inc();
    console.log(get(), n);                  // 13 13
  }
}
const c = new C();
c.run();
c.withParam(10);
