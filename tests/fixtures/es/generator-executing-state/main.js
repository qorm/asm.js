var iter;
function* gNext() { iter.next(); }
iter = gNext();
var threw = false;
try { iter.next(); } catch (e) { threw = e.name === "TypeError"; }
if (!threw) throw new Error("next");
var r = iter.next();
if (!r.done || r.value !== undefined) throw new Error("next-done");

function* gRet() { iter.return(42); }
iter = gRet();
threw = false;
try { iter.next(); } catch (e) { threw = e.name === "TypeError"; }
if (!threw) throw new Error("return");
r = iter.next();
if (!r.done) throw new Error("return-done");

function* gThrow() { iter.throw(1); }
iter = gThrow();
threw = false;
try { iter.next(); } catch (e) { threw = e.name === "TypeError"; }
if (!threw) throw new Error("throw");
r = iter.next();
if (!r.done) throw new Error("throw-done");
console.log("ok");
