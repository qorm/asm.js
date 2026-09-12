print(String(eval("1")));
try {
  eval("'use strict'; var _f = function (param1, param2, param1) { };");
  print("dup=no-throw");
} catch (e) {
  print("dup=" + e.name);
}
try {
  var a = () => { let x; eval("var x;"); };
  a();
  print("arrow=no-throw");
} catch (e) {
  print("arrow=" + e.name);
}
function testAssignment() {
  var x = 0;
  var innerX = (function() {
    x = (eval("var x;"), 1);
    return x;
  })();
  print(String(innerX));
  print(String(x));
}
testAssignment();
