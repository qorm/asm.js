import { StringDecoder } from "node:string_decoder";
import { Buffer } from "node:buffer";

const d = new StringDecoder("utf8");
console.log(d.write(Buffer.from("hello")));
console.log("[" + d.end() + "]");
console.log(d.write("world"));

const d2 = new StringDecoder();
console.log(d2.write(Buffer.from("abc")));
console.log("end:[" + d2.end(Buffer.from("Z")) + "]");
