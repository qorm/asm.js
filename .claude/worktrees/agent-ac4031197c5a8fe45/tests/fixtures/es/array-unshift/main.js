const a = [3, 4];
console.log(a.unshift(2));
console.log(a.join(","));
console.log(a.unshift(1), a.join(","));
const b = [];
for (let i = 0; i < 6; i++) b.unshift(i);
console.log(b.join(","));
