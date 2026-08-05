const k = "a";
const { [k]: v, ...rest } = { a: 1, b: 2, c: 3 };
console.log(v);
console.log(JSON.stringify(rest));
