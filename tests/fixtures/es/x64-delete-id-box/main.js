var st_eval = eval;
if (delete __asmjs_no_such_global__ !== true) throw new Error("miss");
var p3 = 1;
function f() { return delete p3; }
var myObj = { p3: "x" };
var del;
with (myObj) { del = f(); }
if (del !== true && del !== false) throw new Error("del=" + del);
if (myObj.p3 !== "x") throw new Error("with obj");
console.log("ok");
