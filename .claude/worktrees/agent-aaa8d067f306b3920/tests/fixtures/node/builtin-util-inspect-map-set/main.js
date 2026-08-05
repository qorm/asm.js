import util from "node:util";
console.log(util.inspect(new Map([["a", 1], ["b", 2]])));
console.log(util.inspect(new Set([1, 2, 3])));
console.log(util.inspect(new Map()));
console.log(util.inspect(new Set()));
console.log(util.inspect(new Date(0)));
console.log(util.inspect({ items: new Set(["x"]), when: new Date(0) }));
console.log(util.inspect([1, "two", true, null]));
console.log(util.inspect(new Map([["nested", { a: [1, 2] }]])));
