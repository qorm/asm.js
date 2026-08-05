// gen.return()/gen.throw() run finally blocks and propagate correctly.
function show(s) { console.log(s); }

// return() runs finally, then {value, done:true}
{
  let log = [];
  function* g() { try { yield 1; yield 2; } finally { log.push("fin"); } }
  const it = g(); it.next();
  const r = it.return(42);
  show("ret " + log.join(",") + " " + r.value + " " + r.done); // fin 42 true
}
// nested finallys run inner-to-outer
{
  let log = [];
  function* g() { try { try { yield 1; } finally { log.push("in"); } } finally { log.push("out"); } }
  const it = g(); it.next(); it.return(5);
  show("nested " + log.join(",")); // in,out
}
// return() before start: no finally (body never entered)
{
  let log = [];
  function* g() { try { yield 1; } finally { log.push("fin"); } }
  const it = g();
  const r = it.return(7);
  show("prestart " + (log.join(",") || "none") + " " + r.value + " " + r.done + " " + it.next().done); // none 7 true true
}
// yield inside finally during return(): suspends, then completes with injected value
{
  function* g() { try { yield 1; } finally { yield "f"; } }
  const it = g(); it.next();
  const a = it.return(9); const b = it.next();
  show("yfin " + a.value + " " + a.done + " " + b.value + " " + b.done); // f false 9 true
}
// throw() into finally-only try: finally runs, exception re-propagates to caller
{
  let log = [];
  function* g() { try { yield 1; } finally { log.push("fin"); } }
  const it = g(); it.next();
  try { it.throw(new Error("boom")); log.push("noThrow"); } catch (e) { log.push("caught:" + e.message); }
  show("thr " + log.join(",")); // fin,caught:boom
}
// natural throw inside finally-only try propagates through next()
{
  let log = [];
  function* g() { try { yield 1; throw new Error("nat"); } finally { log.push("fin"); } }
  const it = g(); it.next();
  try { it.next(); } catch (e) { log.push("caught:" + e.message); }
  show("nat " + log.join(",")); // fin,caught:nat
}
// throw() with catch inside still handled locally
{
  function* g() { try { yield 1; } catch (e) { yield "c:" + e.message; } }
  const it = g(); it.next();
  const r = it.throw(new Error("x"));
  show("cat " + r.value + " " + r.done); // c:x false
}
// throw() with no try at all propagates
{
  function* g() { yield 1; }
  const it = g(); it.next();
  try { it.throw(new Error("y")); } catch (e) { show("notry caught:" + e.message); } // caught:y
}
// caller's try/catch unaffected by a suspended generator's try frame
{
  function* g() { try { yield 1; } finally {} }
  const it = g(); it.next();
  try { throw new Error("m"); } catch (e) { show("main caught:" + e.message); } // caught:m
}
// regression: plain drain and return-then-exhausted
{
  function* g() { yield 1; yield 2; return 3; }
  let s = 0; for (const v of g()) s += v;
  const it = g(); it.next(); it.return(0);
  show("reg " + s + " " + it.next().done); // 3 true
}
// for-of break closes the iterator (calls return()) and runs finally
{
  let log = [];
  function* g() { try { yield 1; yield 2; } finally { log.push("fin"); } }
  for (const v of g()) { if (v === 1) break; }
  let s = 0; for (const v of g()) s += v; // full drain also runs finally once
  show("forof " + log.join(",") + " " + s); // fin,fin 3
}
