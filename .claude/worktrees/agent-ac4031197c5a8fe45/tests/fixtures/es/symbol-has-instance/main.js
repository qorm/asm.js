class Even { static [Symbol.hasInstance](n) { return typeof n === "number" && n % 2 === 0; } }
console.log(4 instanceof Even, 3 instanceof Even, "x" instanceof Even);
let ArrayLike = { [Symbol.hasInstance](x) { return Array.isArray(x); } };
console.log([] instanceof ArrayLike, {} instanceof ArrayLike);
class A {} class B extends A {}
console.log(new B() instanceof A, new B() instanceof B, {} instanceof A);
console.log([] instanceof Array, new Date() instanceof Date);
console.log(typeof Symbol.hasInstance);
