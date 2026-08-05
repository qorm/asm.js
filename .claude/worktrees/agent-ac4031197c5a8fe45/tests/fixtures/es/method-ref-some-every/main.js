console.log([1, 2, 3].some.call([1, 2, 3], function (x) { return x > 2; }));
console.log([1, 2, 3].some.call([1, 2, 3], function (x) { return x > 5; }));
console.log([2, 4, 6].every.call([2, 4, 6], function (x) { return x % 2 === 0; }));
console.log([2, 4, 5].every.call([2, 4, 5], function (x) { return x % 2 === 0; }));
console.log([].every.call([], function () { return false; }));
var f = [].some;
console.log(f.call([1, 2, 3], function (x, i) { return i === 1; }));
