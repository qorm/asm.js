import util from "node:util";
console.log(typeof util.callbackify);
const f1 = util.callbackify(() => Promise.resolve(42));
f1((err, val) => console.log("a:" + (err === null) + ":" + val));
const f2 = util.callbackify((x) => Promise.resolve(x * 2));
f2(5, (err, val) => console.log("b:" + val));
const f3 = util.callbackify(() => Promise.reject(new Error("boom")));
f3((err) => console.log("c:" + err.message));
