var GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
var gf = GeneratorFunction("a", "b", "return a + b");
print(String(gf.length));
var gfn = new GeneratorFunction("a", "b", "return a + b");
print(String(gfn.length));
class GFn extends GeneratorFunction {}
var sub = new GFn("a", "b", "return a + b");
print(String(sub.length));
var fn = new Function("a", "b", "return a + b");
print(String(fn.length));
