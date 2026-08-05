const o = { a: 1 };
Object.defineProperty(o, "hidden", { enumerable: false, value: 9 });
o.b = 2;
const seen = [];
for (const k in o) seen.push(k);
console.log(seen.join(","));
