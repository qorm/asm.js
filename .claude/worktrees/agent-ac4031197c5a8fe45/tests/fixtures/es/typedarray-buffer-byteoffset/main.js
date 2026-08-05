const ta = new Int32Array([10, 20, 30]);
console.log(ta.buffer.byteLength);
console.log(ta.byteOffset);
console.log(ta.byteLength);
const u = new Uint8Array([1, 2, 3, 4, 5]);
console.log(u.buffer.byteLength, u.byteOffset);
const f = new Float64Array([1.5, 2.5]);
console.log(f.buffer.byteLength, f.byteOffset);
