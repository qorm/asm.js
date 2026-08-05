let p = 50;
const outer = ({ p }) => () => p;
console.log(outer({ p: 77 })());
