function C(x) { this.arg = x; }
var tag = function (s) {
  console.log(s[0]);
  return C;
};
var a = new tag`first`;
console.log(a instanceof C);
console.log(a.arg);
var b = new tag`second`("x");
console.log(b.arg);
