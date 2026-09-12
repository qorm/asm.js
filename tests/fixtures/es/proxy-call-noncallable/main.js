var p = new Proxy({}, {});
var threw = false;
try { p(); } catch (e) { threw = true; }
if (!threw) throw new Error("expected TypeError");
console.log("ok");
