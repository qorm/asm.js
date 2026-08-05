import { Buffer } from "node:buffer";
// Buffer.concat is a static that collides with array/string .concat hoisting.
var a = Buffer.from([1, 2, 3]);
var b = Buffer.from([4, 5]);
var c = Buffer.concat([a, b]);
console.log(c.length, Array.from(c).join(","));
var single = Buffer.concat([a]);
console.log(single.length, Array.from(single).join(","));
var empty = Buffer.concat([]);
console.log(empty.length);
