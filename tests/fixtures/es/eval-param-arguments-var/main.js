function f(p = eval("var arguments = 'param'")) {
  var arguments;
}
var threw = false;
try { f(); } catch (e) { threw = e instanceof SyntaxError; }
if (!threw) throw new Error("expected SyntaxError on assign");
function g(p = eval("var arguments")) {
  var arguments;
}
threw = false;
try { g(); } catch (e) { threw = e instanceof SyntaxError; }
if (!threw) throw new Error("expected SyntaxError on declare");
console.log("ok");
