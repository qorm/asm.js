function decl() {
  print(String(eval("var y; 3")));
}
decl();
var fe = function () {
  print(String(eval("var y; 4")));
};
fe();
function cap() {
  var x = 0;
  var innerX = (function () {
    x = (eval("var x;"), 1);
    return x;
  })();
  print(String(innerX));
  print(String(x));
}
cap();
