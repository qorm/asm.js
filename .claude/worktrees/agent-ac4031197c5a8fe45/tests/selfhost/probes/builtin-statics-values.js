// Builtin namespace statics as first-class values under the g1-compiled compiler:
// typeof, call-via-variable, arr.map(Math.floor) (idiomatic), memoized identity.
const f = Math.floor;
const ok = typeof Math.floor === "function" && f(2.5) === 2 &&
    [1.5, 2.7].map(Math.floor).join(",") === "1,2" &&
    Math.floor === Math.floor && Math.floor !== Math.ceil &&
    typeof Object.keys === "function" &&
    [{ x: 1 }].map(Object.keys).join("") === "x" &&
    Object.keys === Object.keys && typeof Date.now === "function" &&
    Math.floor(9.9) === 9 && // static call unchanged
    typeof Array.isArray === "function" && [[1], "x"].filter(Array.isArray).length === 1;
console.log(ok ? "builtin-statics-ok" : "builtin-statics-FAIL");
