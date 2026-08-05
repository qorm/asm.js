// [dialect] `js f(x)` spawn statement: args evaluated NOW, call runs as a
// coroutine on the event loop after main completes. Deterministic FIFO order.
let n = 0;
function mk() { n++; return n; }
function p(a, b) { console.log("p " + a + " " + b); }

js p(mk(), mk());  // args evaluated immediately (1, 2)
js p(mk(), 0);     // 3
console.log("main " + n);  // 3 — all args already evaluated

// method receiver binding
const o = { tag: "T", m(x) { console.log(this.tag + " " + x); } };
js o.m(9);

// async function spawn (fire-and-forget)
async function af(x) { console.log("async " + x); }
js af(7);

console.log("main-end");
