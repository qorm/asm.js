// Direct eval() lexical-scope capture: a direct `eval(str)` call inside a
// function sees and mutates the CALLER's local variables (via FP + name->slot
// layout copy-in/copy-out), matching Node's direct-eval semantics. Indirect
// eval keeps global scope. Covers: write, read, compound context, multiple
// vars, params, strings, block-scoped eval, var-declared-in-eval (no clobber).

// write a caller local
function f1() { let x = 10; eval("x = 20"); return x; }
console.log(f1());                                   // 20

// read a caller local (completion value)
function f2() { let x = 7; return eval("x + 1"); }
console.log(f2());                                   // 8

// read two, write one
function f3() { let x = 10, y = 5; eval("x = x + y"); return x + ":" + y; }
console.log(f3());                                   // 15:5

// capture a parameter (write-back)
function f4(x) { eval("x = x + 100"); return x; }
console.log(f4(9));                                  // 109

// mutate then continue using the mutated value after eval
function f5() { let c = 0; eval("c = 7"); c = c + 1; return c; }
console.log(f5());                                   // 8

// string capture (read + write-back)
function f6() { let name = "jo"; eval("name = name + 'hn'"); return name; }
console.log(f6());                                   // john

// three vars, read two write one
function f7() { let a = 1, b = 2, c = 3; eval("a = b + c"); return a + "," + b + "," + c; }
console.log(f7());                                   // 5,2,3

// var declared INSIDE eval does not clobber a same-named caller local it reads
function f8() { let x = 1; eval("var z = x + 40"); return x; }
console.log(f8());                                   // 1

// eval nested in a block still captures the enclosing function frame
function f9() { let x = 1; if (true) { eval("x = 42"); } return x; }
console.log(f9());                                   // 42
