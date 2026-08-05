// Computed-key destructuring ASSIGNMENT: ({ [k]: target } = obj) must evaluate k at runtime.
var grault, qux = "corge";
({ [qux]: grault } = { corge: "garply" });
console.log("single", grault);

var a, b, k1 = "x", k2 = "y";
({ [k1]: a, [k2]: b } = { x: 10, y: 20 });
console.log("multi", a, b);

var holder = {}, key = "p";
({ [key]: holder.z } = { p: 99 });
console.log("member", holder.z);

var m, rest, kk = "k";
({ [kk]: m, ...rest } = { k: 1, other: 2, more: 3 });
console.log("withrest", m, rest.other, rest.more, rest.k);
