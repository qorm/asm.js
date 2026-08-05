const c = new Uint8ClampedArray([300, -5, 100, 255, 0, 256, -1]);
console.log(c[0], c[1], c[2], c[3], c[4], c[5], c[6]);
const d = new Uint8ClampedArray(3);
d[0] = 500; d[1] = -100; d[2] = 128;
console.log(d[0], d[1], d[2]);
const u = new Uint8Array([300, -5]);
console.log(u[0], u[1]);
