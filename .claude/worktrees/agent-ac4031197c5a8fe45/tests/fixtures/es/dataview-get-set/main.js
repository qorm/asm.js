const ab = new ArrayBuffer(16);
const dv = new DataView(ab);
dv.setInt32(0, 0x12345678);
console.log(dv.getInt32(0).toString(16), dv.getInt32(0, true).toString(16));
dv.setUint8(4, 200); dv.setInt8(5, -5);
console.log(dv.getUint8(4), dv.getInt8(5), dv.getUint8(5));
dv.setInt16(6, -1000); console.log(dv.getInt16(6));
dv.setUint16(8, 50000, true); console.log(dv.getUint16(8, true));
dv.setFloat64(8, 3.14159); console.log(dv.getFloat64(8));
dv.setFloat32(0, 1.5); console.log(dv.getFloat32(0));
// DataView <-> TypedArray sharing (native LE)
const ta = new Int32Array([0, 0]);
const dv2 = new DataView(ta.buffer);
dv2.setInt32(0, 12345, true);
console.log(ta[0]);
ta[1] = 999;
console.log(dv2.getInt32(4, true));
