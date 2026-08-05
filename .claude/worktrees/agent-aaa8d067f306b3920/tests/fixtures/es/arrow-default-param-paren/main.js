const pick = (value = 7) => value;
console.log(pick(), pick(5));
const add = (a = 1, b = 2) => a + b;
console.log(add(), add(10), add(10, 20));
const mix = (a, b = 9) => a + b;
console.log(mix(1), mix(1, 100));
