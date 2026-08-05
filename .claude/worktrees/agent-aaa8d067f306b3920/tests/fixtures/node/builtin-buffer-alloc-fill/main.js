import { Buffer } from "node:buffer";
console.log(Buffer.alloc(3, 65).toString());
console.log(Buffer.alloc(4, "ab").toString());
console.log(Buffer.alloc(3).toString("hex"));
console.log(Buffer.alloc(0).length);
console.log(Buffer.byteLength("hello"));
