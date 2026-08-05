const util = require("util");
console.log(util.format("%s-%d-%j", "a", 5, { k: 1 }));
console.log(util.inspect({ a: 1, b: [2, 3] }));
console.log(util.isDeepStrictEqual({ a: 1 }, { a: 1 }));
console.log(util.types.isDate(new Date()));
console.log(typeof util.promisify, typeof util.inherits);
