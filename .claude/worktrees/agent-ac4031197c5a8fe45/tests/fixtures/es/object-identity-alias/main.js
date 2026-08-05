const obj = { count: 0 };
const alias = obj;

console.log(obj === alias);
alias.count = 1;
console.log(obj.count);
