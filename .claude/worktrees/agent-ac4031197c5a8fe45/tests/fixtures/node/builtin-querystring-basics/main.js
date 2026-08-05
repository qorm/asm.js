import qs from "node:querystring";

const o = qs.parse("a=1&b=2&c=hello");
console.log(o.a + "," + o.b + "," + o.c);
console.log(qs.stringify({ x: "1", y: "two" }));
console.log(qs.parse("k=a%20b").k);
console.log(qs.stringify({ q: "a b" }));
const t = qs.parse("t=1&t=2");
console.log(Array.isArray(t.t) + ":" + t.t.join(","));
