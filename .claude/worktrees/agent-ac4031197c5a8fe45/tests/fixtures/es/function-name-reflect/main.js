// .name reflection for runtime function values (params / passed-around),
// not just compile-time-static access sites.
function foo(a, b) { return a + b; }
const bar = function baz() {};
function reflect(fn) { return fn.name; }
console.log("[" + foo.name + "]");        // static: foo
console.log("[" + reflect(foo) + "]");    // dynamic through param: foo
console.log("[" + reflect(bar) + "]");    // named function expression: baz
console.log("[" + reflect(function anon() {}) + "]"); // anon: passed inline
// defineProperty override still wins over metadata
Object.defineProperty(foo, "name", { value: "renamed" });
console.log("[" + reflect(foo) + "]");    // renamed
