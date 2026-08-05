import { Buffer } from "node:buffer";

const b = Buffer.from("hello world");
console.log(b.toString("base64"));
console.log(Buffer.from("aGVsbG8=", "base64").toString());
console.log(Buffer.from("68656c6c6f", "hex").toString());
console.log(b.slice(6).toString());
console.log(b.slice(0, 5).toString());
console.log(b.subarray(6).toString());
console.log(Buffer.from("ab").toString("base64"));
console.log(Buffer.from("abc").toString("base64"));
console.log(Buffer.from("f0", "hex").readUInt8(0));
