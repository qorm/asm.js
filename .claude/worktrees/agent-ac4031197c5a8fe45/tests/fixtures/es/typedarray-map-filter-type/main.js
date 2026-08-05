const a = Int8Array.from([1, 2, 3]);
const m = a.map((x) => x * 2);
console.log(Array.from(m), m instanceof Int8Array, m.byteLength);
const f = new Uint8Array([5, 10, 15, 20]).filter((x) => x > 8);
console.log(Array.from(f), f instanceof Uint8Array, f.byteLength);
console.log(new Float64Array([1]) instanceof Float64Array, new Int8Array([1]) instanceof Uint8Array);
console.log([1, 2] instanceof Int8Array, [1, 2, 3, 4].filter((x) => x % 2 === 0).length);
