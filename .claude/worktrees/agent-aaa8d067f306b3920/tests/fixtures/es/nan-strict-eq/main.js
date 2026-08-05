// NaN literal is not === / == to itself (IEEE); other values unaffected
console.log(NaN === NaN);
console.log(NaN !== NaN);
console.log(NaN == NaN);
console.log(1 === 1, "a" === "a", null === null, 1.5 === 1.5);
console.log(1 === 2, "x" === "y", null === undefined);
