const o = { a: 1, b: 2 };
Object.defineProperty(o, "hidden", { enumerable: false, value: 99 });
console.log(Object.keys(o).join(","));
console.log(Object.values(o).join(","));
console.log(JSON.stringify(Object.entries(o)));
console.log(JSON.stringify(o));
console.log(o.hidden);
