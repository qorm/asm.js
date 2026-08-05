console.log(JSON.stringify(Array.from({ length: 3, 0: "a", 1: "b", 2: "c" })));
console.log(JSON.stringify(Array.from({ length: 3, 0: "a", 1: "b", 2: "c" }, (x) => x + "!")));
console.log(JSON.stringify(Array.from({ length: 2 })));
console.log(JSON.stringify(Array.from({ length: 4, 0: 10, 2: 30 }, (x, i) => i)));
