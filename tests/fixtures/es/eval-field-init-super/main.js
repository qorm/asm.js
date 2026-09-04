var executed = false;
var A = class {}
var C = class extends A {
  x = eval("executed = true; super.x;");
};
new C();
console.log(executed);
