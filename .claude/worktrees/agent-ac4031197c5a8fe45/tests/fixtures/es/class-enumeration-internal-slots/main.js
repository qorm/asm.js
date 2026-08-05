class C { static foo() { return 1; } static bar = 42; static baz = "x"; m() { return 5; } }
console.log(Object.keys(C).join(","));
console.log(Object.values(C).join(","));
console.log(Object.entries(C).map(function (e) { return e[0] + "=" + e[1]; }).join(","));
let fi = [];
for (let k in C) fi.push(k);
console.log(fi.join(","));
console.log(JSON.stringify(C));
let o = { a: 1, greet() { return "hi"; }, b: 2 };
console.log(Object.keys(o).join(","));
