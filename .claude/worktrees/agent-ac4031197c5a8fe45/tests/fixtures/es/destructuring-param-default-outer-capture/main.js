let a = 111;
const dv = ({ x = a }) => x;
let base = 7;
const dva = ([p = base]) => p;
function outer() { let z = 42; return ({ y = z }) => y; }
console.log(dv({}), dv({ x: 5 }));
console.log(dva([]), dva([9]));
console.log(outer()({}));
