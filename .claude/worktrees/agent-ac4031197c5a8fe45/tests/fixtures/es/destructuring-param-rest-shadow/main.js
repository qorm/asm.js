let r = 1;
const rr = ({ a, ...r }) => JSON.stringify(r);
console.log(rr({ a: 1, m: 2, n: 3 }));
