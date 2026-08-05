// console.log of TypedArrays prints "Type(len) [ elems ]" (matches node),
// nested and multi-arg too; Promise no longer segfaults.
console.log(new Uint8Array([1, 2, 3]));
console.log(new Int32Array([5, 6]));
console.log(new Float64Array([1.5, 2.5]));
console.log(new Uint8Array([]));
console.log("x", new Uint8Array([1, 2, 3]), "y");
console.log([new Uint8Array([9, 8])]);
var p = Promise.resolve(1);
console.log(typeof p, p instanceof Promise);
