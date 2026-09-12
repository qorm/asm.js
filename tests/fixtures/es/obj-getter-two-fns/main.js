function f1() {
  var o = { get a() { return 1; } };
  if (o.a !== 1) throw new Error("f1");
}
function f2() {
  var o = { get b() { return 2; } };
  if (o.b !== 2) throw new Error("f2");
}
f1();
f2();
var g1 = function () {
  var o = { get a() { return 3; } };
  if (o.a !== 3) throw new Error("g1");
};
var g2 = function () {
  var o = { get b() { return 4; } };
  if (o.b !== 4) throw new Error("g2");
};
g1();
g2();
console.log("ok");
