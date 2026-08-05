// Design A: multiple typed views + DataView over ONE ArrayBuffer share bytes.
const buf = new ArrayBuffer(16);
const i32 = new Int32Array(buf);
const u8 = new Uint8Array(buf);
i32[0] = 0x01020304;
console.log(u8[0], u8[1], u8[2], u8[3]); // 4 3 2 1 (little-endian)
u8[4] = 0xFF; u8[5] = 0xFF; u8[6] = 0xFF; u8[7] = 0x7F;
console.log(i32[1]); // 2147483647
const dv = new DataView(buf);
dv.setInt32(0, 1000, true);
console.log(i32[0]); // 1000 (view sees DataView write)
console.log(dv.getInt32(0, true)); // 1000
// windowed view with a byteOffset shares the same memory
const v = new Int32Array(buf, 8);
console.log(v.byteOffset, v.length); // 8 2
v[0] = 12345;
console.log(i32[2]); // 12345 (i32[2] aliases v[0])
// .buffer returns the REAL backing buffer (stable identity)
console.log(i32.buffer === buf, v.buffer === buf, u8.buffer === buf); // true true true
console.log(i32.byteOffset, v.byteOffset); // 0 8
