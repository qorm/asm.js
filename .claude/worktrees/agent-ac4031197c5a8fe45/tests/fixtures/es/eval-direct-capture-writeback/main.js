// Direct eval() where a closure created INSIDE the eval WRITES BACK a captured
// caller-local scalar (Engine round-3 milestone). The forEach/reduce callbacks
// run synchronously during the eval; their assignments to the captured var must
// be visible after eval returns. Root fix: copy-in reboxes any caller local that
// is captured by a fragment-internal closure into a shared heap box (mirroring
// the normal compiler's rebox-on-capture), so the closure and the fragment share
// one box and copy-out reads the box back into the caller slot. Matches Node.

// scalar sum written by forEach closure
function f1() { let s = 0; eval("[1,2,3].forEach(v => { s = s + v })"); return s; }
console.log(f1());                                   // 6

// initial non-zero + write
function f2() { let s = 1; eval("[2,3,4].forEach(v => { s = s + v })"); return s; }
console.log(f2());                                   // 10

// reduce over captured accumulator seed (read case, still boxed)
function f3() { let acc = 100; return eval("[1,2,3].reduce((a, v) => a + v, acc)"); }
console.log(f3());                                   // 106

// map reads captured var (read case, snapshot-consistent)
function f4() { let base = 10; return eval("[1,2,3].map(v => v + base)").join(","); }
console.log(f4());                                   // 11,12,13

// string accumulator written by closure
function f5() { let out = ""; eval("['a','b','c'].forEach(v => { out = out + v })"); return out; }
console.log(f5());                                   // abc

// two captured vars both written in one closure
function f6() { let sum = 0, cnt = 0; eval("[5,10,15].forEach(v => { sum = sum + v; cnt = cnt + 1 })"); return sum + "/" + cnt; }
console.log(f6());                                   // 30/3

// nested arrow writing captured var across two levels
function f7() { let s = 0; eval("[[1,2],[3,4]].forEach(row => row.forEach(v => { s = s + v }))"); return s; }
console.log(f7());                                   // 10

// escaping read closure: g() reads copy-out'd captured value
function f8() { let base = 7; let g = eval("(function(){ return base })"); return g(); }
console.log(f8());                                   // 7
