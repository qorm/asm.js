// Stresses wasm32 memory-access lowering: loads/stores at many static offsets.
// Non-negative offsets fold into the wasm memarg immediate; heap-header reads
// (obj-16/obj-8, exercised by typeof and string concat) keep the i64.add path.
// Guards that folding against regression. Output is identical native vs wasm.

// object with many fields -> distinct positive struct offsets
const o = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
console.log(o.a, o.b, o.c, o.d, o.e, o.f, o.g, o.h);

// array element loads/stores (indexed offsets)
const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
let sum = 0;
for (let i = 0; i < arr.length; i++) sum += arr[i];
console.log("nums", sum);

// nested object fields (chained pointer + offset reads)
const nested = { inner: { value: 42, more: { leaf: 7 } } };
console.log("nested", nested.inner.value, "deep", nested.inner.more.leaf);

// typed array reads/writes (byte/element offsets)
const ta = new Int32Array(4);
ta[0] = 10; ta[1] = 20; ta[2] = 30; ta[3] = 40;
let tsum = ta[0] + ta[1] + ta[2] + ta[3];
console.log("typed", ta.join(","), "sum", tsum);

// string concat -> rope/header (negative-offset header access)
const s = "ab" + "-" + "cd" + "-" + "ef";
console.log(s, "xyz");

// typeof across values -> header type-byte reads (negative offsets)
function fn() { return 0; }
console.log("types", typeof 3, typeof "x", typeof true, typeof {}, typeof fn, typeof undefined);

// Uint8 clamped-range byte stores/loads
const u = new Uint8Array(3);
u[0] = 255; u[1] = 0; u[2] = 128;
console.log("bytes", u[0], u[1], u[2]);

// write-then-read many object fields to force store+load at each offset
const rec = {};
rec.x0 = 100; rec.x1 = 101; rec.x2 = 102; rec.x3 = 103;
const ok = rec.x0 === 100 && rec.x1 === 101 && rec.x2 === 102 && rec.x3 === 103;
console.log("fields", ok ? "ok" : "bad");
