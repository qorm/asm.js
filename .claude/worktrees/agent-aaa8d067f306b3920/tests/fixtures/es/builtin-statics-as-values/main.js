// Namespace builtin statics as first-class values (memoized closures over the
// runtime helpers). Calls keep static dispatch — only value-position changes.
console.log(typeof Math.floor, typeof Object.keys, typeof Date.now);
const f = Math.floor;
console.log(f(2.5), f(-1.5));
console.log([1.5, 2.7, 3.2].map(Math.floor).join(","));
console.log([4, 9, 16].map(Math.sqrt).join(","));
const fns = [Math.floor, Math.ceil, Math.trunc];
console.log(fns.map(fn => fn(3.7)).join(","));
console.log(Math.floor === Math.floor, Math.floor === Math.ceil);
const k = Object.keys;
console.log(k({ a: 1, b: 2 }).join(","));
console.log([{ x: 1 }, { y: 2 }].map(Object.keys).join("|"));
console.log([{ a: 10, b: 20 }].map(Object.values)[0].join(","));
console.log(Object.keys === Object.keys);
// static calls unchanged
console.log(Math.floor(2.9), Math.max(1, 5, 3), Object.keys({ q: 1 }).join(","));
console.log(typeof Array.isArray, [[1], "x", [2]].filter(Array.isArray).length, Array.isArray === Array.isArray);
