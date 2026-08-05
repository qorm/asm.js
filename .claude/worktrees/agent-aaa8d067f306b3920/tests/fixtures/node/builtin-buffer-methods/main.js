import { Buffer } from "node:buffer";

const a = Buffer.from("hello");
const b = Buffer.from("hello");
const c = Buffer.from("world");
console.log(a.equals(b));
console.log(a.equals(c));
console.log(a.compare(c));
console.log(Buffer.compare(a, c));
console.log(Buffer.compare(a, b));

const f = Buffer.alloc(4);
f.fill(65);
console.log(f.toString());

const src = Buffer.from("abcd");
const dst = Buffer.alloc(4);
console.log(src.copy(dst));
console.log(dst.toString());

const w = Buffer.alloc(8);
w.writeUInt16LE(0x0102, 0);
w.writeUInt32BE(0x03040506, 2);
w.writeInt8(-5, 6);
console.log(w.readUInt16LE(0));
console.log(w.readUInt32BE(2));
console.log(w.readInt8(6));
