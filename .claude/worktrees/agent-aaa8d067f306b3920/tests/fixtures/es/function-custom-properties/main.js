// Custom properties on functions (fn.x = 1) via the closure props side-table,
// plus stable function-declaration identity (f === f).
function f() {}
f.x = 1;
f.x = 2;
console.log(f.x, f.missing);        // 2 undefined
f.count = 0;
f.count = f.count + 1;
console.log(f.count);               // 1
console.log(f === f);               // true (memoized closure identity)
const g = f;
console.log(f === g);               // true (alias identity)
const arw = () => {};
arw.label = "hi"; arw.n = 42;
console.log(arw.label, arw.n);      // hi 42
const fe = function (a, b) {};
fe.meta = "m";
console.log(fe.meta, fe.name, fe.length); // m fe 2
