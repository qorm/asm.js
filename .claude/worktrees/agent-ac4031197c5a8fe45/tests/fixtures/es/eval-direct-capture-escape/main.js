// Direct eval() that creates a closure which ESCAPES the eval (returned/stored),
// AFTER which the caller mutates the captured local — the escaped closure must
// observe the caller's later writes (and vice-versa), because they share ONE cell.
// Engine round-4 milestone. Root fix: a function containing a direct eval has ALL
// its copy-in-eligible locals upgraded to a heap box (caller-frame model change,
// analyzeDirectEvalBoxedVars); the eval call site tags such vars ":b" in the
// capture layout; the fragment copy-in REUSES the caller's box (no value snapshot)
// and copy-out is a no-op, so caller and fragment closure look at one shared box.
// The naive model returned the copy-out snapshot (stale). Matches Node.

// milestone: escaping closure, then caller writes -> closure sees new value
function f1() { let base = 10; let g = eval("(function(){ return base })"); base = 20; return g(); }
console.log(f1());                                   // 20

// multiple later writes
function f2() { let x = 1; let g = eval("(function(){ return x })"); x = 2; x = 3; return g(); }
console.log(f2());                                   // 3

// captured parameter, mutated after eval
function f3(a) { let g = eval("(function(){ return a })"); a = a + 100; return g(); }
console.log(f3(5));                                  // 105

// two captured vars, both written after eval
function f4() { let x = 1, y = 2; let g = eval("(function(){ return x + ',' + y })"); x = 10; y = 20; return g(); }
console.log(f4());                                   // 10,20

// escaping closure that WRITES the captured var; caller reads after
function f5() { let n = 5; let g = eval("(function(){ n = n + 1; return n })"); let r1 = g(); let r2 = g(); return n + "/" + r1 + "/" + r2; }
console.log(f5());                                   // 7/6/7

// caller interleaves writes between escaping-closure calls
function f6() { let x = 0; let g = eval("(function(){ return x })"); x = 100; let a = g(); x = 200; let b = g(); return a + "/" + b; }
console.log(f6());                                   // 100/200

// var also captured by a REAL (non-eval) closure in the same function; eval writes it
function f7() { let x = 1; let h = () => x; eval("x = 50"); return h() + "/" + x; }
console.log(f7());                                   // 50/50

// nested function containing the direct eval (frame-model change applies per-function)
function f8() { function inner(){ let z = 1; let g = eval("(function(){ return z })"); z = 42; return g(); } return inner(); }
console.log(f8());                                   // 42

// arrow function containing the direct eval
const f9 = () => { let w = 3; let g = eval("(function(){ return w })"); w = 9; return g(); };
console.log(f9());                                   // 9
