console.log(typeof [].slice, typeof "".charCodeAt);
console.log([1, 2, 3, 4, 5].slice.call([1, 2, 3, 4, 5], 1, 3).join(","));
console.log([1, 2, 3, 4].slice.call([1, 2, 3, 4], 2).join(","));
console.log([1, 2, 3].slice.call([1, 2, 3]).join(","));
console.log([1, 2, 3, 4, 5].slice.call([1, 2, 3, 4, 5], -2).join(","));
console.log([1, 2, 3, 4].slice.call([1, 2, 3, 4], 1, -1).join(","));
console.log("ABC".charCodeAt.call("ABC", 0));
console.log("ABC".charCodeAt.call("ABC", 2));
