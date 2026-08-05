let b = 99;
const nest = ({ a: { b } }) => b;
console.log(nest({ a: { b: 42 } }));
