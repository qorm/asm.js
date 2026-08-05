// Destructuring in ASSIGNMENT position (not declaration) with defaults + nested + rest.
let a, b, c, d, e, x, y, rest;

// object shorthand default, key absent -> default
({ a = 1 } = {});
console.log("a " + a); // 1
// object shorthand default, key present -> value wins
({ b = 1 } = { b: 7 });
console.log("b " + b); // 7
// mixed defaults + plain in one object pattern
({ c = 3, d, e = 5 } = { d: 2 });
console.log("cde " + c + " " + d + " " + e); // 3 2 5
// nested object pattern with shorthand defaults
({ p: { x = 10, y = 20 } } = { p: { x: 11 } });
console.log("xy " + x + " " + y); // 11 20
// array element default in assignment position
[a, b = 99] = [8];
console.log("arr " + a + " " + b); // 8 99
// array rest in assignment position
[a, ...rest] = [1, 2, 3, 4];
console.log("rest " + a + " " + rest.join(",")); // 1 2,3,4
// nested array default present -> value
[x, y = 5] = [3, 4];
console.log("arr2 " + x + " " + y); // 3 4
