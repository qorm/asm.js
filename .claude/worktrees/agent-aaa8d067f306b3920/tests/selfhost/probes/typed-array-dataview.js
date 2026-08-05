const buf = new ArrayBuffer(16);
const i32 = new Int32Array(buf);
const u8 = new Uint8Array(buf);
i32[0] = 0x01020304;
const dv = new DataView(buf);
dv.setInt32(4, 1000, true);
const clamped = new Uint8Array([255, 256, 257]);
const ok = u8[0] === 4 && u8[3] === 1 && dv.getInt32(4, true) === 1000 &&
    i32.buffer === buf && clamped[1] === 0 &&
    new Int32Array([10, 20, 30]).reduce((s, x) => s + x, 0) === 60;
console.log(ok ? "typed-array-ok" : "typed-array-FAIL");
