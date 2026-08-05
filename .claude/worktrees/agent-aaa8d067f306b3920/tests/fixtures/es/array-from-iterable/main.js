// Array.from over non-array iterables: generator, Set, string (+ mapFn)
function* g() { yield 1; yield 2; yield 3; }
console.log(Array.from(g()).join(","));
console.log(Array.from(g(), (x) => x * 2).join(","));
console.log(Array.from(new Set([5, 5, 6, 7])).join(","));
console.log(Array.from("abc").join(","));
console.log(Array.from([9, 8]).join(","));
