function f(x, y, z) { return x + y + z; }
var b = Function.prototype.bind.call(f, {}, "a", "b", "c");
if (b() !== "abc") throw new Error("call=" + b());
function g() {}
Object.defineProperty(g, "length", { value: undefined });
if (Function.prototype.bind.call(g, null, 1).length !== 0) throw new Error("length");
console.log("ok");
