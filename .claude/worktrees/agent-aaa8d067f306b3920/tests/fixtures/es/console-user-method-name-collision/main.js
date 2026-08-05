// console.log of a user method whose name collides with a builtin boolean method
// must print the actual (non-boolean) return value, not "true"/"false".
var o = { test() { return 42; }, has(k) { return "has:" + k; }, includes() { return 99; }, startsWith() { return "SW"; } };
console.log(o.test(), o.has("x"), o.includes(), o.startsWith());
class C { test() { return "user-test"; } }
console.log(new C().test());
// real builtin boolean methods still render as booleans
console.log(/ab/.test("xab"), [1, 2].includes(2), "hi".startsWith("h"));
var m = new Map([["a", 1]]); console.log(m.has("a"), m.has("z"));
