function f(n) {
  "use strict";
  if (n === 0) return 1;
  return eval(n - 1);
}
eval = f;
if (f(2000) !== 1) throw new Error("eval-tco");
(function () {
  function g(n) {
    "use strict";
    if (n === 0) return 2;
    return eval(n - 1);
  }
  eval("var eval = g;");
  if (g(2000) !== 2) throw new Error("eval-tco-dynamic");
})();
console.log("ok");
