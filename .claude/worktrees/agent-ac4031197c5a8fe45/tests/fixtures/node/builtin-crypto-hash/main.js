import crypto from "node:crypto";

const a = crypto.createHash("sha256").update("hello").digest("hex");
const b = crypto.createHash("sha256").update("hello").digest("hex");
const c = crypto.createHash("sha256").update("world").digest("hex");
console.log(a.length);
console.log(a === b);
console.log(a === c);
console.log(crypto.createHash("md5").update("x").digest("hex").length);
console.log(crypto.createHash("sha1").update("x").digest("hex").length);
console.log(crypto.createHash("sha512").update("x").digest("hex").length);
const chained = crypto.createHash("sha256").update("a").update("b").digest("hex");
console.log(chained.length === 64);
