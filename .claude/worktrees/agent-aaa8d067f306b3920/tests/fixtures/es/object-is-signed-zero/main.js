console.log(Object.is(-0, 0));
console.log(Object.is(0, -0));
console.log(Object.is(-0, -0));
console.log(Object.is(0, 0));
console.log(Object.is(NaN, NaN));
console.log(Object.is(5, 5));
console.log(Object.is({}, {}));
console.log(Object.is(Infinity, -Infinity));
