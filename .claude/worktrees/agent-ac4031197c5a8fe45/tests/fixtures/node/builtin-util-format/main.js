import util from "node:util";

console.log(util.format("hi %s num %d", "there", 42));
console.log(util.format("no fmt", "extra"));
console.log(util.format("x=%d", 5, { a: 1 }));
console.log(util.inspect({ a: 1, b: "hi" }));
console.log(util.inspect([1, 2, 3]));
console.log(util.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }));
console.log(util.isDeepStrictEqual({ a: 1 }, { a: 2 }));

function cbStyle(x, cb) { cb(null, x * 10); }
const p = util.promisify(cbStyle);
p(5).then((r) => console.log("promisified:" + r));
