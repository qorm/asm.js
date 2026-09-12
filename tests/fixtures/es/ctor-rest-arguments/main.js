class Base {
  constructor(...a) {
    if (a[0] !== 1 || a[1] !== 2 || a[2] !== 3) throw new Error("rest");
    if (arguments[0] !== 1 || arguments[1] !== 2 || arguments[2] !== 3) {
      throw new Error("arguments " + arguments[0]);
    }
    if (arguments.length !== 3) throw new Error("argc");
    this.base = a;
  }
}
class Child extends Base {
  constructor(...b) {
    super(1, 2, 3);
    if (b[0] !== 9 || arguments[0] !== 9) throw new Error("child " + arguments[0]);
    this.child = b;
  }
}
var c = new Child(9, 8, 7);
if (c.base[0] !== 1 || c.child[0] !== 9) throw new Error("stored");
console.log("ok");
