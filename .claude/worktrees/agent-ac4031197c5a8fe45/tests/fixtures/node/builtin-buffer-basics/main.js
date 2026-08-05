import { Buffer } from "node:buffer";

const b = Buffer.from("hello");
console.log(b.length);
console.log(b.toString());
console.log(Buffer.isBuffer(b));
console.log(Buffer.isBuffer("x"));
console.log(Buffer.byteLength("hello"));
console.log(Buffer.alloc(4).length);
console.log(Buffer.from([104, 105]).toString());
console.log(b.slice(1, 3).toString());
const w = Buffer.alloc(2);
w.writeUInt8(65, 0);
console.log(w.readUInt8(0));
