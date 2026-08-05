// Direct eval() mutating a CAPTURED array/object in-place, and closures created
// inside eval reading a captured caller var. Round-2 engine follow-ups #1 (read
// case) and #2. The caller's local array/object is copy-in with identity
// preserved, so member-set / array-mutator methods mutate the shared heap
// object; the mutation is visible after eval returns (matches Node).

// object member reassignment through captured object
function o1() { let o = { k: 1 }; eval("o.k = 9"); return o.k; }
console.log(o1());                                   // 9

// new property on captured object
function o2() { let o = {}; eval("o.n = 5"); return o.n; }
console.log(o2());                                   // 5

// multiple property writes
function o3() { let o = { a: 1 }; eval("o.b = 2; o.c = 3"); return o.a + "," + o.b + "," + o.c; }
console.log(o3());                                   // 1,2,3

// array push (in-place, length + element visible after eval)
function a1() { let a = [1, 2]; eval("a.push(3)"); return a.join(","); }
console.log(a1());                                   // 1,2,3

// two pushes in one eval
function a2() { let a = []; eval("a.push(1); a.push(2)"); return a.length; }
console.log(a2());                                   // 2

// pop
function a3() { let a = [1, 2, 3]; eval("a.pop()"); return a.join(","); }
console.log(a3());                                   // 1,2

// shift
function a4() { let a = [1, 2, 3]; eval("a.shift()"); return a.join(","); }
console.log(a4());                                   // 2,3

// unshift
function a5() { let a = [2, 3]; eval("a.unshift(1)"); return a.join(","); }
console.log(a5());                                   // 1,2,3

// splice
function a6() { let a = [1, 2, 3, 4]; eval("a.splice(1, 2)"); return a.join(","); }
console.log(a6());                                   // 1,4

// subscript element write through captured array
function a7() { let a = [1, 2]; eval("a[0] = 9"); return a.join(","); }
console.log(a7());                                   // 9,2

// eval completion value (push returns new length) alongside mutation
function a8() { let a = [5]; let r = eval("a.push(6)"); return r + "|" + a.join(","); }
console.log(a8());                                   // 2|5,6

// #1 read case: closure created inside eval reads a captured caller var
function c1() { let base = 10; return eval("[1,2,3].map(v => v + base)").join(","); }
console.log(c1());                                   // 11,12,13

// closure over captured var + reduce (addition)
function c2() { let acc = 100; return eval("[1,2,3].reduce((s, v) => s + v, acc)"); }
console.log(c2());                                   // 106
