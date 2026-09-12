var f = Function("var eval;");
if (typeof f !== "function") throw new Error("var eval");
var g = Function("var x; return x;");
if (g() !== undefined) throw new Error("var x");
var h = Function("'use strict'; var f1 = Function(\"var o = {}; with (o) {};\")");
h();
console.log("ok");
