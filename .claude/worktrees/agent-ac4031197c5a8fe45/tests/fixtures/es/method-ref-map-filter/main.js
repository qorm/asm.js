console.log(typeof [].map, typeof [].filter);
console.log([1, 2, 3].map.call([1, 2, 3], function (x) { return x * 2; }).join(","));
console.log([10, 20].map.call([10, 20], function (x, i) { return i + ":" + x; }).join(","));
console.log([1, 2, 3, 4, 5].filter.call([1, 2, 3, 4, 5], function (x) { return x % 2 === 0; }).join(","));
var k = 100;
console.log([1, 2].map.call([1, 2], function (x) { return x + k; }).join(","));
var m = [].map;
console.log(m.apply([3, 4], [function (x) { return x * 10; }]).join(","));
