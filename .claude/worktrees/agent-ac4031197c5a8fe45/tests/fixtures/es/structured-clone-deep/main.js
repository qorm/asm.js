const orig = { a: [1, 2, { b: 3 }], c: { d: [4, 5] } };
const cl = structuredClone(orig);
cl.a[2].b = 99;
cl.c.d[0] = 77;
console.log(orig.a[2].b, cl.a[2].b);
console.log(orig.c.d[0], cl.c.d[0]);
console.log(orig === cl, orig.a === cl.a, JSON.stringify(cl));
