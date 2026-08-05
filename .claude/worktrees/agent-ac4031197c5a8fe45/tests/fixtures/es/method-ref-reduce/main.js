console.log(typeof [].reduce, typeof [].reduceRight);
console.log([1, 2, 3, 4].reduce.call([1, 2, 3, 4], function (a, x) { return a + x; }, 0));
console.log([1, 2, 3, 4].reduce.call([1, 2, 3, 4], function (a, x) { return a + x; }));
console.log(["a", "b", "c"].reduce.call(["a", "b", "c"], function (a, x) { return a + x; }, ""));
console.log([1, 2, 3].reduce.call([1, 2, 3], function (a, x) { a.push(x * 2); return a; }, []).join(","));
console.log(["a", "b", "c"].reduceRight.call(["a", "b", "c"], function (a, x) { return a + x; }, ""));
console.log([1, 2, 3, 4].reduceRight.call([1, 2, 3, 4], function (a, x) { return a - x; }));
var f = [].reduce;
console.log(f.call([2, 3, 4], function (a, x) { return a * x; }, 1));
