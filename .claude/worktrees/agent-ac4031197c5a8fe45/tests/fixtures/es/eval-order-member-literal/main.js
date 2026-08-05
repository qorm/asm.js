// ES evaluation order: member assignment (object -> key -> value), computed
// object-literal properties (key -> value, incl. ToPropertyKey before value),
// and compound assignment evaluating the member base/key exactly ONCE.

// (1) o()[k()] = v(): strict left-to-right
var log1 = [];
function o1() { log1.push("o"); return {}; }
function k1() { log1.push("k"); return "x"; }
function v1() { log1.push("v"); return 1; }
o1()[k1()] = v1();
console.log(log1.join(","));                       // o,k,v

// nested: o(1)[k(1)][k(2)] = 1 (read of outer base is also ordered)
var log2 = [];
function o2(n) { log2.push("o" + n); return { x: {} }; }
function k2(n) { log2.push("k" + n); return "x"; }
o2(1)[k2(1)][k2(2)] = 1;
console.log(log2.join(","));                       // o1,k1,k2

// read side: o()[k()]
var log3 = [];
function o3() { log3.push("o"); return { x: 9 }; }
function k3() { log3.push("k"); return "x"; }
console.log(o3()[k3()], log3.join(","));            // 9 o,k

// object evaluated first is used even if key eval rebinds the variable
var a4 = [10, 20], b4 = [30, 40]; var t4 = a4;
function k4() { t4 = b4; return 0; }
console.log(t4[k4()]);                              // 10

// object eval mutates the (pure) key variable: key read AFTER object eval
var i5 = 0; var a5 = [[1, 2]];
function o5() { i5 = 1; return a5[0]; }
console.log(o5()[i5]);                              // 2

// (2) computed object-literal: key before value, per property
var log6 = [];
function k6(n) { log6.push(n); return n; }
var ob6 = { [k6("a")]: k6("1"), [k6("b")]: k6("2") };
console.log(log6.join(","), ob6.a, ob6.b);          // a,1,b,2 1 2

// ToPropertyKey (toString) runs before the value
var log7 = [];
var keyObj7 = { toString() { log7.push("ts"); return "kk"; } };
function v7() { log7.push("v"); return 5; }
var ob7 = { [keyObj7]: v7() };
console.log(log7.join(","), ob7.kk);                // ts,v 5

// (3) compound assignment: base evaluated once
var log8 = []; var q8 = { v: 1 };
function o8() { log8.push("o"); return q8; }
o8().v += 5;
console.log(log8.join(","), q8.v);                  // o 6

var log9 = []; var a9 = [10];
function o9() { log9.push("o"); return a9; }
o9()[0] += 5;
console.log(log9.join(","), a9[0]);                 // o 15

// computed key side effect evaluated once
var i10 = 0; var a10 = [10, 20];
a10[i10++] += 5;
console.log(a10.join(","), i10);                    // 15,20 1

// pure hot paths unchanged
var m = [[1, 2], [3, 4]]; m[1][0] += 10;
var o11 = { n: 10 }; o11.n -= 2; o11.n *= 3;
console.log(JSON.stringify(m), o11.n);              // [[1,2],[13,4]] 24
